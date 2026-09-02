import { createHash } from "node:crypto";
import {
  ComputerError,
  DISPLAY,
  asPixelX,
  asPixelY,
  asPoint,
  inBounds,
  type Action,
  type ActionResult,
  type PendingCheck,
  type Point,
  type SeatState,
  type Unavailable,
  unavailable,
} from "@computer/shared";
import type { Desk } from "../desk/types.ts";
import { PNG_MEDIA } from "../desk/types.ts";
import { BoundedCache } from "./cache.ts";
import { PolicyService, type PolicyVerdict } from "./policy.ts";
import type { SeatService } from "./seat.ts";

export type ComputerOk = {
  results: ActionResult[];
  screenshot_b64?: string;
  display: typeof DISPLAY;
  cursor?: Point;
  seat: SeatState;
  pending_checks: PendingCheck[];
};

type Cached = { bodyHash: string; response: Promise<ComputerOk> };

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
  /**
   * request_id → the first run's promise. Stored before the batch starts so a
   * retry that overlaps the original waits on it instead of running twice —
   * that is the double-click `request_id` exists to prevent. Bounded, so a
   * long-lived hub does not keep every screenshot it ever returned.
   */
  private readonly cache = new BoundedCache<Cached>();
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
      throw new ComputerError("VALIDATION", `actions must have 1–${MAX_ACTIONS} items`);
    }
    // The whole batch is checked before any of it runs: a limit violation in
    // action 3 must not leave actions 1–2 executed under an id that can never
    // be retried.
    actions.forEach((action, i) => validateAction(action, i));

    const bodyHash = hashBody(requestId, actions);
    const hit = this.cache.get(requestId);
    if (hit) {
      if (hit.bodyHash !== bodyHash) {
        throw new ComputerError("CONFLICT", "request_id reused with a different body");
      }
      return hit.response;
    }

    const response = this.execute(actions);
    this.cache.set(requestId, { bodyHash, response });
    return response.catch((err) => {
      // A batch that never ran (SEAT_HELD, DAEMON_DOWN) is not a result to replay.
      this.cache.delete(requestId);
      throw err;
    });
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
      if (!skip && this.seat.getState() !== "AGENT") skip = "seat_taken";
      if (skip) {
        results.push({ kind: "skipped", reason: skip });
        continue;
      }
      // Before the box is touched, and before duration_ms starts: a denial is
      // not a slow action, it is a different outcome.
      const verdict = await this.policy.evaluate({ tool: "computer", action });
      if (verdict.decision !== "allow") {
        if (verdict.decision === "ask") asked.push(verdict);
        results.push({ kind: "denied", rule: verdict.rule, reason: verdict.reason });
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
      } catch (err) {
        results.push({ kind: "error", duration_ms: Date.now() - started, ...toError(err) });
        lastExecuted = action;
        skip = "prior_failed";
      }
    }

    // `ask` denies now and explains why: the check rides alongside the denial
    // so the model stops and asks the human instead of retrying blind.
    const pending_checks = takeover ? [] : [...this.askChecks(asked), ...(await this.collectChecks())];

    // One screenshot after the batch unless the last executed action already
    // carries an image. A batch that ran nothing (denied, seat taken) still
    // gets one: the model needs to see the state it is being told to stop in.
    const needsShot = lastExecuted?.type !== "screenshot" && lastExecuted?.type !== "zoom";
    const screenshot_b64 = needsShot ? (await this.desk.screenshot()).toString("base64") : undefined;

    return {
      results,
      screenshot_b64,
      display: DISPLAY,
      cursor: this.desk.getCursor(),
      seat: this.seat.getState(),
      pending_checks,
    };
  }

  private async perform(action: Action): Promise<Omit<Extract<ActionResult, { kind: "ok" }>, "duration_ms">> {
    switch (action.type) {
      case "screenshot": {
        const buf = await this.desk.screenshot();
        return { kind: "ok", image_b64: buf.toString("base64"), media_type: PNG_MEDIA };
      }
      case "click":
        await this.desk.click(action.x, action.y, action.button ?? "left");
        return { kind: "ok" };
      case "double_click":
        await this.desk.doubleClick(action.x, action.y, action.button ?? "left");
        return { kind: "ok" };
      case "scroll":
        await this.desk.scroll(action.x, action.y, action.dx, action.dy);
        return { kind: "ok" };
      case "keypress":
        await this.desk.keypress(action.keys);
        return { kind: "ok" };
      case "type":
        await this.desk.type(action.text);
        return { kind: "ok" };
      case "move":
        await this.desk.move(action.x, action.y);
        return { kind: "ok" };
      case "drag":
        await this.desk.drag(action.path);
        return { kind: "ok" };
      case "wait":
        await sleep(action.ms);
        return { kind: "ok" };
      case "zoom": {
        const buf = await this.desk.zoom(action.x, action.y, action.w, action.h);
        return { kind: "ok", image_b64: buf.toString("base64"), media_type: PNG_MEDIA };
      }
      case "request_takeover":
        this.seat.requestTakeover();
        return { kind: "ok" };
    }
  }

  /** A policy `ask` becomes the advisory it always should have been. */
  private askChecks(asked: PolicyVerdict[]): PendingCheck[] {
    return asked.map((v) => ({
      id: `chk_${++this.checkSeq}`,
      code: "destructive" as const,
      message: `${v.rule} needs the human: ${v.reason}`,
    }));
  }

  private async collectChecks(): Promise<PendingCheck[]> {
    const hint = await this.desk.focusHint();
    const out: PendingCheck[] = [];
    if (hint.password) {
      out.push({
        id: `chk_${++this.checkSeq}`,
        code: "credential",
        message: `password field or auth dialog is focused (${hint.title || "untitled"})`,
      });
    }
    if (hint.confirm) {
      out.push({
        id: `chk_${++this.checkSeq}`,
        code: "destructive",
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
export function validateAction(action: Action, index: number): void {
  const at = `actions[${index}]`;
  const point = (x: number, y: number) => {
    if (!inBounds(x, y)) {
      throw new ComputerError("OUT_OF_BOUNDS", `${at}: ${x},${y} outside ${DISPLAY.width}x${DISPLAY.height}`);
    }
  };
  const int = (v: number, name: string, min: number, max: number) => {
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new ComputerError("VALIDATION", `${at}.${name} must be an integer in ${min}..${max}`);
    }
  };
  switch (action.type) {
    case "screenshot":
    case "request_takeover":
      return;
    case "click":
    case "double_click":
    case "move":
      point(action.x, action.y);
      return;
    case "scroll":
      point(action.x, action.y);
      int(action.dx, "dx", -SCROLL_CAP, SCROLL_CAP);
      int(action.dy, "dy", -SCROLL_CAP, SCROLL_CAP);
      return;
    case "keypress":
      if (!Array.isArray(action.keys) || action.keys.length < 1 || action.keys.length > KEYS_CAP) {
        throw new ComputerError("VALIDATION", `${at}.keys must have 1–${KEYS_CAP} items`);
      }
      if (action.keys.some((k) => typeof k !== "string" || k.length === 0)) {
        throw new ComputerError("VALIDATION", `${at}.keys must be non-empty strings`);
      }
      return;
    case "type":
      if (typeof action.text !== "string" || action.text.length < 1 || action.text.length > TEXT_CAP) {
        throw new ComputerError("VALIDATION", `${at}.text must be 1–${TEXT_CAP} chars`);
      }
      return;
    case "drag":
      if (!Array.isArray(action.path) || action.path.length < 2 || action.path.length > DRAG_CAP) {
        throw new ComputerError("VALIDATION", `${at}.path must have 2–${DRAG_CAP} points`);
      }
      for (const p of action.path) point(p.x, p.y);
      return;
    case "wait":
      int(action.ms, "ms", 1, WAIT_CAP_MS);
      return;
    case "zoom":
      point(action.x, action.y);
      int(action.w, "w", 1, DISPLAY.width);
      int(action.h, "h", 1, DISPLAY.height);
      if (action.x + action.w > DISPLAY.width || action.y + action.h > DISPLAY.height) {
        throw new ComputerError("OUT_OF_BOUNDS", `${at}: zoom rectangle exceeds display`);
      }
      return;
    default:
      throw new ComputerError("VALIDATION", `${at}: unknown action type`);
  }
}

/** Carries the DAEMON_DOWN detail into the per-action result, not just the envelope. */
function toError(err: unknown): { code: ComputerError["code"]; message: string } & Partial<Unavailable> {
  if (err instanceof ComputerError) return { code: err.code, message: err.message, ...err.detail };
  return {
    code: "DAEMON_DOWN",
    message: err instanceof Error ? err.message : "unknown error",
    ...unavailable("unknown", "unknown"),
  };
}

function hashBody(requestId: string, actions: Action[]): string {
  return createHash("sha256").update(JSON.stringify({ requestId, actions })).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wire JSON → typed actions. Shape only; limits are `validateAction`'s job. */
export function parseActions(raw: unknown): Action[] {
  if (!Array.isArray(raw)) throw new ComputerError("VALIDATION", "actions must be an array");
  return raw.map((item, i) => parseAction(item, i));
}

function parseAction(raw: unknown, index: number): Action {
  if (!raw || typeof raw !== "object") {
    throw new ComputerError("VALIDATION", `actions[${index}] is not an object`);
  }
  const a = raw as Record<string, unknown>;
  const type = a.type;
  if (typeof type !== "string") throw new ComputerError("VALIDATION", `actions[${index}].type is required`);
  switch (type) {
    case "screenshot":
    case "request_takeover":
      return { type };
    case "click":
    case "double_click":
      return {
        type,
        x: asPixelX(num(a.x, `${type}.x`)),
        y: asPixelY(num(a.y, `${type}.y`)),
        ...(a.button !== undefined ? { button: button(a.button) } : {}),
      };
    case "move":
      return { type, x: asPixelX(num(a.x, "move.x")), y: asPixelY(num(a.y, "move.y")) };
    case "scroll":
      return {
        type: "scroll",
        x: asPixelX(num(a.x, "scroll.x")),
        y: asPixelY(num(a.y, "scroll.y")),
        dx: num(a.dx, "scroll.dx"),
        dy: num(a.dy, "scroll.dy"),
      };
    case "keypress":
      if (!Array.isArray(a.keys) || a.keys.some((k) => typeof k !== "string")) {
        throw new ComputerError("VALIDATION", "keypress.keys must be strings");
      }
      return { type: "keypress", keys: a.keys as string[] };
    case "type":
      if (typeof a.text !== "string") throw new ComputerError("VALIDATION", "type.text must be a string");
      return { type: "type", text: a.text };
    case "drag":
      if (!Array.isArray(a.path)) throw new ComputerError("VALIDATION", "drag.path must be an array");
      return {
        type: "drag",
        path: a.path.map((p, j) => {
          if (!p || typeof p !== "object") throw new ComputerError("VALIDATION", `drag.path[${j}]`);
          const pt = p as Record<string, unknown>;
          return asPoint(num(pt.x, `path[${j}].x`), num(pt.y, `path[${j}].y`));
        }),
      };
    case "wait":
      return { type: "wait", ms: num(a.ms, "wait.ms") };
    case "zoom":
      return {
        type: "zoom",
        x: asPixelX(num(a.x, "zoom.x")),
        y: asPixelY(num(a.y, "zoom.y")),
        w: num(a.w, "zoom.w"),
        h: num(a.h, "zoom.h"),
      };
    default:
      throw new ComputerError("VALIDATION", `unknown action type ${type}`);
  }
}

function num(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ComputerError("VALIDATION", `${field} must be a number`);
  }
  return v;
}

function button(v: unknown): "left" | "right" | "middle" | "back" | "forward" {
  if (v === "left" || v === "right" || v === "middle" || v === "back" || v === "forward") return v;
  throw new ComputerError("VALIDATION", "button must be left|right|middle|back|forward");
}
