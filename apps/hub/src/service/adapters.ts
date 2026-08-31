/**
 * Hosted CUA adapters. Native is the protocol; these only map inbound.
 * Gemini 0–999 is divided then multiplied into 1280×800. We never emit 0–999.
 */
import { DISPLAY, asPixelX, asPixelY, type Action, type Button } from "@computer/shared";

const CLAUDE_CLICK: Record<string, Action["type"]> = {
  left_click: "click",
  right_click: "click",
  middle_click: "click",
  double_click: "double_click",
  left_click_drag: "drag",
};

export function fromOpenAI(actions: unknown[]): Action[] {
  return actions.map((a) => normalize({ ...(a as object) } as Record<string, unknown>));
}

export function fromClaude(actions: unknown[]): Action[] {
  return actions.map((raw) => {
    const a = { ...(raw as object) } as Record<string, unknown>;
    const t = String(a.type ?? a.action ?? "");
    if (t === "left_click") return normalize({ ...a, type: "click", button: a.button ?? "left" });
    if (t === "right_click") return normalize({ ...a, type: "click", button: "right" });
    if (t === "middle_click") return normalize({ ...a, type: "click", button: "middle" });
    if (t in CLAUDE_CLICK) return normalize({ ...a, type: CLAUDE_CLICK[t] });
    return normalize(a);
  });
}

/** Gemini normalized 0–999 → pixels. Drop navigate (type into the URL bar instead). */
export function fromGemini(actions: unknown[]): Action[] {
  const out: Action[] = [];
  for (const raw of actions) {
    const a = { ...(raw as object) } as Record<string, unknown>;
    if (a.type === "navigate" || a.action === "navigate") continue;
    if (typeof a.x === "number" && a.x >= 0 && a.x <= 999) a.x = geminiX(a.x);
    if (typeof a.y === "number" && a.y >= 0 && a.y <= 999) a.y = geminiY(a.y);
    if (Array.isArray(a.path)) {
      a.path = (a.path as { x: number; y: number }[]).map((p) => ({
        x: geminiX(p.x),
        y: geminiY(p.y),
      }));
    }
    out.push(normalize(a));
  }
  return out;
}

export function geminiX(n: number): number {
  return Math.round((n / 999) * (DISPLAY.width - 1));
}

export function geminiY(n: number): number {
  return Math.round((n / 999) * (DISPLAY.height - 1));
}

function normalize(a: Record<string, unknown>): Action {
  const type = String(a.type ?? a.action);
  switch (type) {
    case "screenshot":
    case "request_takeover":
      return { type };
    case "click":
    case "double_click":
      return {
        type,
        x: asPixelX(Number(a.x)),
        y: asPixelY(Number(a.y)),
        button: (a.button as Button | undefined) ?? "left",
      };
    case "scroll":
      return {
        type: "scroll",
        x: asPixelX(Number(a.x)),
        y: asPixelY(Number(a.y)),
        dx: Number(a.dx ?? a.scroll_x ?? 0),
        dy: Number(a.dy ?? a.scroll_y ?? 0),
      };
    case "keypress":
      return { type: "keypress", keys: Array.isArray(a.keys) ? (a.keys as string[]) : [String(a.key)] };
    case "type":
      return { type: "type", text: String(a.text ?? a.contents ?? "") };
    case "move":
      return { type: "move", x: asPixelX(Number(a.x)), y: asPixelY(Number(a.y)) };
    case "drag":
      return {
        type: "drag",
        path: ((a.path as { x: number; y: number }[]) ?? []).map((p) => ({
          x: asPixelX(p.x),
          y: asPixelY(p.y),
        })),
      };
    case "wait":
      return { type: "wait", ms: Number(a.ms ?? a.duration_ms ?? 0) };
    case "zoom":
      return {
        type: "zoom",
        x: asPixelX(Number(a.x)),
        y: asPixelY(Number(a.y)),
        w: Number(a.w ?? a.width),
        h: Number(a.h ?? a.height),
      };
    default:
      return { type: "screenshot" };
  }
}
