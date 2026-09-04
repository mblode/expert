import { createHash } from "node:crypto";
import {
  ComputerError,
  DISPLAY,
  FOCUS_TITLE_CAP,
  asPixelX,
  asPixelY,
  asPoint,
  inBounds,
  unavailable,
} from "@computer/shared";
import type {
  Action,
  ActionResult,
  ImageMeta,
  PendingCheck,
  Point,
  SeatState,
  Unavailable,
  WindowFocus,
} from "@computer/shared";
import { pngSize } from "../desk/png.ts";
import type { Desk, FocusHint } from "../desk/types.ts";
import { PNG_MEDIA } from "../desk/types.ts";
import { RequestCache } from "./cache.ts";
import { PolicyService } from "./policy.ts";
import type { PolicyVerdict } from "./policy.ts";
import type { SeatService } from "./seat.ts";

interface ComputerOk {
  results: ActionResult[];
  screenshot_b64?: string;
  /** Metadata for `screenshot_b64`, absent whenever those bytes are. */
  screenshot?: ImageMeta;
  display: typeof DISPLAY;
  cursor?: Point;
  seat: SeatState;
  pending_checks: PendingCheck[];
  /** Which window the batch ended in. Page-controlled text; see WindowFocus. */
  focus?: WindowFocus;
}

const MAX_ACTIONS = 20;
const WAIT_CAP_MS = 8000;
const SCROLL_CAP = 20;
const KEYS_CAP = 5;
const TEXT_CAP = 4000;
const DRAG_CAP = 32;

export class ComputerService {
  private readonly desk: Desk;
  private readonly seat: SeatService;
  private readonly policy: PolicyService;
  /** request_id idempotency; see RequestCache. */
  private readonly cache = new RequestCache<ComputerOk>();
  private checkSeq = 0;

  constructor(desk: Desk, seat: SeatService, policy: PolicyService = new PolicyService()) {
    this.desk = desk;
    this.seat = seat;
    this.policy = policy;
  }

  async run(requestId: string, actions: Action[]): Promise<ComputerOk> {
    if (!requestId || typeof requestId !== "string") {
      throw new ComputerError("VALIDATION", "request_id is required");
    }
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_ACTIONS) {
      throw new ComputerError("VALIDATION", `actions must have 1-${MAX_ACTIONS} items`);
    }
    // The whole batch is checked before any of it runs: a limit violation in
    // action 3 must not leave actions 1–2 executed under an id that can never
    // be retried.
    for (const [i, action] of actions.entries()) {
      validateAction(action, i);
    }

    return this.cache.run(requestId, hashBody(requestId, actions), () => this.execute(actions));
  }

  private async execute(actions: Action[]): Promise<ComputerOk> {
    this.seat.requireAgent();
    await this.desk.ping();

    const results: ActionResult[] = [];
    let skip: Extract<ActionResult, { kind: "skipped" }>["reason"] | null = null;
    let lastExecuted: Action | undefined;
    let takeover = false;
    const asked: PolicyVerdict[] = [];

    for (const action of actions) {
      // A human may take the seat while a long batch is running. The person
      // watching the machine wins; the rest of the batch is not run.
      if (!skip && this.seat.getState() !== "AGENT") {
        skip = "seat_taken";
      }
      if (skip) {
        results.push({ kind: "skipped", reason: skip });
        continue;
      }
      // Before the box is touched, and before duration_ms starts: a denial is
      // not a slow action, it is a different outcome.
      const verdict = await this.policy.evaluate({ action, tool: "computer" });
      if (verdict.decision !== "allow") {
        if (verdict.decision === "ask") {
          asked.push(verdict);
        }
        results.push({ kind: "denied", reason: verdict.reason, rule: verdict.rule });
        skip = "after_denied";
        continue;
      }
      const started = Date.now();
      try {
        const result = await this.perform(action);
        results.push({ ...result, duration_ms: Date.now() - started });
        lastExecuted = action;
        if (action.type === "request_takeover") {
          takeover = true;
          skip = "after_takeover";
        }
      } catch (error) {
        results.push({ kind: "error", duration_ms: Date.now() - started, ...toError(error) });
        lastExecuted = action;
        skip = "prior_failed";
      }
    }

    // One read of the focused window for the whole batch, after it has run so
    // it describes the state the model is being handed back.
    const hint = await this.readFocus();

    // `ask` denies now and explains why: the check rides alongside the denial
    // so the model stops and asks the human instead of retrying blind.
    const pending_checks = takeover ? [] : [...this.askChecks(asked), ...this.collectChecks(hint)];

    // One screenshot after the batch unless the last executed action already
    // carries an image. A batch that ran nothing (denied, seat taken) still
    // gets one: the model needs to see the state it is being told to stop in.
    const needsShot = lastExecuted?.type !== "screenshot" && lastExecuted?.type !== "zoom";
    const shot = needsShot ? await this.desk.screenshot() : undefined;

    return {
      cursor: this.desk.getCursor(),
      display: DISPLAY,
      focus: focusOf(hint),
      pending_checks,
      results,
      screenshot: shot && imageMeta(shot),
      screenshot_b64: shot?.toString("base64"),
      seat: this.seat.getState(),
    };
  }

  private async perform(
    action: Action,
  ): Promise<Omit<Extract<ActionResult, { kind: "ok" }>, "duration_ms">> {
    switch (action.type) {
      case "screenshot": {
        const buf = await this.desk.screenshot();
        return {
          image: imageMeta(buf),
          image_b64: buf.toString("base64"),
          kind: "ok",
          media_type: PNG_MEDIA,
        };
      }
      case "click": {
        await this.desk.click(action.x, action.y, action.button ?? "left");
        return { kind: "ok" };
      }
      case "double_click": {
        await this.desk.doubleClick(action.x, action.y, action.button ?? "left");
        return { kind: "ok" };
      }
      case "scroll": {
        await this.desk.scroll(action.x, action.y, action.dx, action.dy);
        return { kind: "ok" };
      }
      case "keypress": {
        await this.desk.keypress(action.keys);
        return { kind: "ok" };
      }
      case "type": {
        await this.desk.type(action.text);
        return { kind: "ok" };
      }
      case "move": {
        await this.desk.move(action.x, action.y);
        return { kind: "ok" };
      }
      case "drag": {
        await this.desk.drag(action.path);
        return { kind: "ok" };
      }
      case "wait": {
        await sleep(action.ms);
        return { kind: "ok" };
      }
      case "zoom": {
        const buf = await this.desk.zoom(action.x, action.y, action.w, action.h);
        // The crop states the rectangle it came from, because the next action
        // is still addressed in the full display's coordinates.
        return {
          image: imageMeta(buf, { h: action.h, w: action.w, x: action.x, y: action.y }),
          image_b64: buf.toString("base64"),
          kind: "ok",
          media_type: PNG_MEDIA,
        };
      }
      case "request_takeover": {
        this.seat.requestTakeover();
        return { kind: "ok" };
      }
    }
  }

  /** A policy `ask` becomes the advisory it always should have been. */
  private askChecks(asked: PolicyVerdict[]): PendingCheck[] {
    return asked.map((v) => ({
      code: "destructive" as const,
      id: `chk_${++this.checkSeq}`,
      message: `${v.rule} needs the human: ${v.reason}`,
    }));
  }

  /**
   * One `xdotool getwindowname` per batch, feeding both `pending_checks` and
   * `focus`. It used to be skipped on the takeover path, which is the one
   * batch where naming the window matters most.
   *
   * The failure is swallowed, and that is a change: this read used to throw
   * out of `execute` after the actions had already run. A rejected run is
   * forgotten by the RequestCache, by design, so that a batch which never
   * started can be retried under its id. A throw from here is the opposite
   * case: the clicks happened, and the retry the model is invited to make
   * runs them again. Losing an advisory check is the smaller harm than a
   * double-executed batch, so a title we cannot read costs the checks that
   * hang off it and nothing else.
   */
  private async readFocus(): Promise<FocusHint> {
    try {
      return await this.desk.focusHint();
    } catch {
      return { confirm: false, password: false, title: "" };
    }
  }

  private collectChecks(hint: FocusHint): PendingCheck[] {
    const out: PendingCheck[] = [];
    if (hint.password) {
      out.push({
        code: "credential",
        id: `chk_${++this.checkSeq}`,
        message: `password field or auth dialog is focused (${hint.title || "untitled"})`,
      });
    }
    if (hint.confirm) {
      out.push({
        code: "destructive",
        id: `chk_${++this.checkSeq}`,
        message: `confirm dialog is frontmost (${hint.title || "untitled"})`,
      });
    }
    return out;
  }
}

/**
 * The limits from api/spec.json, enforced before anything runs. Coordinates
 * outside the display are OUT_OF_BOUNDS; every other violation is VALIDATION.
 */
function validateAction(action: Action, index: number): void {
  const at = `actions[${index}]`;
  const point = (x: number, y: number) => {
    if (!inBounds(x, y)) {
      throw new ComputerError(
        "OUT_OF_BOUNDS",
        `${at}: ${x},${y} outside ${DISPLAY.width}x${DISPLAY.height}`,
      );
    }
  };
  const int = (v: number, name: string, min: number, max: number) => {
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new ComputerError("VALIDATION", `${at}.${name} must be an integer in ${min}..${max}`);
    }
  };
  switch (action.type) {
    case "screenshot":
    case "request_takeover": {
      return;
    }
    case "click":
    case "double_click":
    case "move": {
      point(action.x, action.y);
      return;
    }
    case "scroll": {
      point(action.x, action.y);
      int(action.dx, "dx", -SCROLL_CAP, SCROLL_CAP);
      int(action.dy, "dy", -SCROLL_CAP, SCROLL_CAP);
      return;
    }
    case "keypress": {
      if (!Array.isArray(action.keys) || action.keys.length < 1 || action.keys.length > KEYS_CAP) {
        throw new ComputerError("VALIDATION", `${at}.keys must have 1-${KEYS_CAP} items`);
      }
      if (action.keys.some((k) => typeof k !== "string" || k.length === 0)) {
        throw new ComputerError("VALIDATION", `${at}.keys must be non-empty strings`);
      }
      return;
    }
    case "type": {
      if (
        typeof action.text !== "string" ||
        action.text.length < 1 ||
        action.text.length > TEXT_CAP
      ) {
        throw new ComputerError("VALIDATION", `${at}.text must be 1-${TEXT_CAP} chars`);
      }
      return;
    }
    case "drag": {
      if (!Array.isArray(action.path) || action.path.length < 2 || action.path.length > DRAG_CAP) {
        throw new ComputerError("VALIDATION", `${at}.path must have 2–${DRAG_CAP} points`);
      }
      for (const p of action.path) point(p.x, p.y);
      return;
    }
    case "wait": {
      int(action.ms, "ms", 1, WAIT_CAP_MS);
      return;
    }
    case "zoom": {
      point(action.x, action.y);
      int(action.w, "w", 1, DISPLAY.width);
      int(action.h, "h", 1, DISPLAY.height);
      if (action.x + action.w > DISPLAY.width || action.y + action.h > DISPLAY.height) {
        throw new ComputerError("OUT_OF_BOUNDS", `${at}: zoom rectangle exceeds display`);
      }
      return;
    }
    default: {
      throw new ComputerError("VALIDATION", `${at}: unknown action type`);
    }
  }
}

/** Carries the DAEMON_DOWN detail into the per-action result, not just the envelope. */
function toError(
  err: unknown,
): { code: ComputerError["code"]; message: string } & Partial<Unavailable> {
  if (err instanceof ComputerError) {
    return { code: err.code, message: err.message, ...err.detail };
  }
  return {
    code: "DAEMON_DOWN",
    message: err instanceof Error ? err.message : "unknown error",
    ...unavailable("unknown", "unknown"),
  };
}

/**
 * Name an image by its content.
 *
 * A random id would do to refer back to a screenshot; a content hash also
 * makes two identical screens carry one id, which is how a model learns that
 * its click changed nothing without diffing pixels. Truncated to 16 hex
 * characters: 64 bits is far past collision range for the handful of images
 * one task produces, and the id is read by a model, not a database.
 */
function imageMeta(buf: Buffer, source?: ImageMeta["source"]): ImageMeta | undefined {
  const size = pngSize(buf);
  if (!size) {
    return undefined;
  }
  return {
    height: size.height,
    id: `img_${createHash("sha256").update(buf).digest("hex").slice(0, 16)}`,
    width: size.width,
    ...(source ? { source } : {}),
  };
}

/**
 * The window title, made safe to put in front of a model.
 *
 * Control and format characters go first: a title carrying newlines or a bidi
 * override could otherwise fake a line of transcript, which is the only way a
 * bounded label becomes an injection. Then it is capped, because a page may
 * set a title of any length and this field is a label. What survives is still
 * the page's text and is still never to be followed.
 */
function focusOf(hint: FocusHint): WindowFocus | undefined {
  const title = hint.title.replaceAll(/\p{C}/gu, " ").trim().slice(0, FOCUS_TITLE_CAP).trim();
  return title ? { title } : undefined;
}

function hashBody(requestId: string, actions: Action[]): string {
  return createHash("sha256").update(JSON.stringify({ actions, requestId })).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wire JSON → typed actions. Shape only; limits are `validateAction`'s job. */
export function parseActions(raw: unknown): Action[] {
  if (!Array.isArray(raw)) {
    throw new ComputerError("VALIDATION", "actions must be an array");
  }
  return raw.map((item, i) => parseAction(item, i));
}

function parseAction(raw: unknown, index: number): Action {
  if (!raw || typeof raw !== "object") {
    throw new ComputerError("VALIDATION", `actions[${index}] is not an object`);
  }
  const a = raw as Record<string, unknown>;
  const { type } = a;
  if (typeof type !== "string") {
    throw new ComputerError("VALIDATION", `actions[${index}].type is required`);
  }
  switch (type) {
    case "screenshot":
    case "request_takeover": {
      return { type };
    }
    case "click":
    case "double_click": {
      return {
        type,
        x: asPixelX(num(a.x, `${type}.x`)),
        y: asPixelY(num(a.y, `${type}.y`)),
        ...(a.button === undefined ? {} : { button: button(a.button) }),
      };
    }
    case "move": {
      return { type, x: asPixelX(num(a.x, "move.x")), y: asPixelY(num(a.y, "move.y")) };
    }
    case "scroll": {
      return {
        type: "scroll",
        x: asPixelX(num(a.x, "scroll.x")),
        y: asPixelY(num(a.y, "scroll.y")),
        dx: num(a.dx, "scroll.dx"),
        dy: num(a.dy, "scroll.dy"),
      };
    }
    case "keypress": {
      if (!Array.isArray(a.keys) || a.keys.some((k) => typeof k !== "string")) {
        throw new ComputerError("VALIDATION", "keypress.keys must be strings");
      }
      return { type: "keypress", keys: a.keys as string[] };
    }
    case "type": {
      if (typeof a.text !== "string")
        throw new ComputerError("VALIDATION", "type.text must be a string");
      return { type: "type", text: a.text };
    }
    case "drag": {
      if (!Array.isArray(a.path))
        throw new ComputerError("VALIDATION", "drag.path must be an array");
      return {
        type: "drag",
        path: a.path.map((p, j) => {
          if (!p || typeof p !== "object") throw new ComputerError("VALIDATION", `drag.path[${j}]`);
          const pt = p as Record<string, unknown>;
          return asPoint(num(pt.x, `path[${j}].x`), num(pt.y, `path[${j}].y`));
        }),
      };
    }
    case "wait": {
      return { type: "wait", ms: num(a.ms, "wait.ms") };
    }
    case "zoom": {
      return {
        type: "zoom",
        x: asPixelX(num(a.x, "zoom.x")),
        y: asPixelY(num(a.y, "zoom.y")),
        w: num(a.w, "zoom.w"),
        h: num(a.h, "zoom.h"),
      };
    }
    default: {
      throw new ComputerError("VALIDATION", `unknown action type ${type}`);
    }
  }
}

function num(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ComputerError("VALIDATION", `${field} must be a number`);
  }
  return v;
}

function button(v: unknown): "left" | "right" | "middle" | "back" | "forward" {
  if (v === "left" || v === "right" || v === "middle" || v === "back" || v === "forward") {
    return v;
  }
  throw new ComputerError("VALIDATION", "button must be left|right|middle|back|forward");
}
