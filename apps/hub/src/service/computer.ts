import { createHash } from "node:crypto";
import {
  ACTION_TYPES,
  ComputerError,
  DISPLAY,
  asPixelX,
  asPixelY,
  asPoint,
  assertInBounds,
  inBounds,
  type Action,
  type ActionResult,
  type PendingCheck,
  type Point,
  type SeatState,
} from "@computer/shared";
import type { Desk } from "../desk/types.ts";
import { PNG_MEDIA } from "../desk/types.ts";
import type { SeatService } from "./seat.ts";

export type ComputerOk = {
  results: ActionResult[];
  screenshot_b64?: string;
  display: typeof DISPLAY;
  cursor?: Point;
  seat: SeatState;
  pending_checks: PendingCheck[];
};

type Cached = { bodyHash: string; response: ComputerOk };

const MAX_ACTIONS = 20;
const WAIT_CAP_MS = 8000;

export class ComputerService {
  private readonly desk: Desk;
  private readonly seat: SeatService;
  private readonly cache = new Map<string, Cached>();
  private checkSeq = 0;

  constructor(desk: Desk, seat: SeatService) {
    this.desk = desk;
    this.seat = seat;
  }

  async run(requestId: string, actions: Action[]): Promise<ComputerOk> {
    if (!requestId || typeof requestId !== "string") {
      throw new ComputerError("VALIDATION", "request_id is required");
    }
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_ACTIONS) {
      throw new ComputerError("VALIDATION", "actions must have 1–20 items");
    }

    const bodyHash = hashBody(requestId, actions);
    const hit = this.cache.get(requestId);
    if (hit) {
      if (hit.bodyHash !== bodyHash) {
        throw new ComputerError("CONFLICT", "request_id reused with a different body");
      }
      return hit.response;
    }

    this.seat.requireAgent();
    await this.desk.ping();

    const results: ActionResult[] = [];
    let skip: "prior_failed" | "after_takeover" | null = null;
    let lastExecuted: Action | undefined;
    let takeover = false;

    for (const action of actions) {
      if (skip) {
        results.push({ kind: "skipped", reason: skip });
        continue;
      }
      const started = Date.now();
      try {
        const result = await this.execute(action);
        const duration_ms = Date.now() - started;
        results.push({ ...result, duration_ms });
        lastExecuted = action;
        if (action.type === "request_takeover") {
          takeover = true;
          skip = "after_takeover";
        }
      } catch (err) {
        const duration_ms = Date.now() - started;
        const { code, message } = toError(err);
        results.push({ kind: "error", duration_ms, code, message });
        lastExecuted = action;
        skip = "prior_failed";
      }
    }

    const pending_checks = takeover ? [] : await this.collectChecks();

    const needsShot =
      lastExecuted !== undefined &&
      lastExecuted.type !== "screenshot" &&
      lastExecuted.type !== "zoom" &&
      results.some((r) => r.kind === "ok" || r.kind === "error");

    let screenshot_b64: string | undefined;
    if (needsShot) {
      screenshot_b64 = (await this.desk.screenshot()).toString("base64");
    }

    const response: ComputerOk = {
      results,
      screenshot_b64,
      display: DISPLAY,
      cursor: this.desk.getCursor(),
      seat: this.seat.getState(),
      pending_checks,
    };
    this.cache.set(requestId, { bodyHash, response });
    return response;
  }

  private async execute(action: Action): Promise<Omit<Extract<ActionResult, { kind: "ok" }>, "duration_ms">> {
    assertAction(action);
    switch (action.type) {
      case "screenshot": {
        const buf = await this.desk.screenshot();
        return { kind: "ok", image_b64: buf.toString("base64"), media_type: PNG_MEDIA };
      }
      case "click": {
        assertInBounds(action.x, action.y);
        await this.desk.click(action.x, action.y, action.button ?? "left");
        return { kind: "ok" };
      }
      case "double_click": {
        assertInBounds(action.x, action.y);
        await this.desk.doubleClick(action.x, action.y, action.button ?? "left");
        return { kind: "ok" };
      }
      case "scroll": {
        assertInBounds(action.x, action.y);
        if (!Number.isInteger(action.dx) || !Number.isInteger(action.dy)) {
          throw new ComputerError("VALIDATION", "scroll dx/dy must be integers");
        }
        if (Math.abs(action.dx) > 20 || Math.abs(action.dy) > 20) {
          throw new ComputerError("VALIDATION", "scroll dx/dy must be in -20..20");
        }
        await this.desk.scroll(action.x, action.y, action.dx, action.dy);
        return { kind: "ok" };
      }
      case "keypress": {
        if (!Array.isArray(action.keys) || action.keys.length < 1 || action.keys.length > 5) {
          throw new ComputerError("VALIDATION", "keypress keys must have 1–5 items");
        }
        await this.desk.keypress(action.keys);
        return { kind: "ok" };
      }
      case "type": {
        if (typeof action.text !== "string" || action.text.length < 1 || action.text.length > 4000) {
          throw new ComputerError("VALIDATION", "type text must be 1–4000 chars");
        }
        await this.desk.type(action.text);
        return { kind: "ok" };
      }
      case "move": {
        assertInBounds(action.x, action.y);
        await this.desk.move(action.x, action.y);
        return { kind: "ok" };
      }
      case "drag": {
        if (!Array.isArray(action.path) || action.path.length < 2 || action.path.length > 32) {
          throw new ComputerError("VALIDATION", "drag path must have 2–32 points");
        }
        for (const p of action.path) assertInBounds(p.x, p.y);
        await this.desk.drag(action.path);
        return { kind: "ok" };
      }
      case "wait": {
        if (!Number.isInteger(action.ms) || action.ms < 1 || action.ms > WAIT_CAP_MS) {
          throw new ComputerError("VALIDATION", "wait ms must be 1–8000");
        }
        await sleep(action.ms);
        return { kind: "ok" };
      }
      case "zoom": {
        assertInBounds(action.x, action.y);
        if (!Number.isInteger(action.w) || !Number.isInteger(action.h) || action.w < 1 || action.h < 1) {
          throw new ComputerError("VALIDATION", "zoom w/h must be ≥ 1");
        }
        if (action.x + action.w > DISPLAY.width || action.y + action.h > DISPLAY.height) {
          throw new ComputerError("OUT_OF_BOUNDS", "zoom rectangle exceeds display");
        }
        const buf = await this.desk.zoom(action.x, action.y, action.w, action.h);
        return { kind: "ok", image_b64: buf.toString("base64"), media_type: PNG_MEDIA };
      }
      case "request_takeover": {
        this.seat.requestTakeover();
        return { kind: "ok" };
      }
    }
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

function assertAction(action: Action): void {
  if (!action || !ACTION_TYPES.includes(action.type)) {
    throw new ComputerError("VALIDATION", `unknown action ${JSON.stringify(action)}`);
  }
  if (action.type === "click" || action.type === "double_click" || action.type === "move") {
    if (!inBounds(action.x, action.y)) {
      // assertInBounds in execute; keep for completeness
    }
  }
}

function toError(err: unknown): { code: ComputerError["code"]; message: string } {
  if (err instanceof ComputerError) return { code: err.code, message: err.message };
  return { code: "DAEMON_DOWN", message: err instanceof Error ? err.message : "unknown error" };
}

function hashBody(requestId: string, actions: Action[]): string {
  return createHash("sha256").update(JSON.stringify({ requestId, actions })).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
    case "move":
      return {
        type,
        x: asPixelX(num(a.x, `${type}.x`)),
        y: asPixelY(num(a.y, `${type}.y`)),
        ...(type !== "move" && a.button !== undefined ? { button: button(a.button) } : {}),
      } as Action;
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
