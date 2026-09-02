import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import type { ToolModelOutputPart } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { hubRpc } from "../hub.ts";

/** 1280×800, origin top-left. The hub rejects anything outside. */
const x = z.number().int().min(0).max(1279);
const y = z.number().int().min(0).max(799);
const button = z.enum(["left", "right", "middle", "back", "forward"]).optional();

/**
 * The action union from api/spec.json, as the schema the model sees. A closed
 * union here means a malformed action is caught before it costs a round trip
 * to the hub, and the model reads the fields off the schema instead of a skill.
 */
const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("screenshot") }),
  z.object({ button, type: z.literal("click"), x, y }),
  z.object({ button, type: z.literal("double_click"), x, y }),
  z.object({
    dx: z.number().int().min(-20).max(20).describe("Wheel ticks right (+) or left (-)"),
    dy: z.number().int().min(-20).max(20).describe("Wheel ticks down (+) or up (-)"),
    type: z.literal("scroll"),
    x,
    y,
  }),
  z.object({
    keys: z.array(z.string().min(1)).min(1).max(5).describe('One chord, e.g. ["ctrl","l"]'),
    type: z.literal("keypress"),
  }),
  z.object({ text: z.string().min(1).max(4000), type: z.literal("type") }),
  z.object({ type: z.literal("move"), x, y }),
  z.object({
    path: z
      .array(z.object({ x, y }))
      .min(2)
      .max(32)
      .describe("Down at the first point, up at the last"),
    type: z.literal("drag"),
  }),
  z.object({ ms: z.number().int().min(1).max(8000), type: z.literal("wait") }),
  z.object({
    h: z.number().int().min(1).max(800),
    type: z.literal("zoom"),
    w: z.number().int().min(1).max(1280),
    x,
    y,
  }),
  z.object({ type: z.literal("request_takeover") }),
]);

interface ActionResult {
  kind: "ok" | "error" | "denied" | "skipped";
  image_b64?: string;
  media_type?: string;
  [k: string]: unknown;
}

interface ComputerResponse {
  results: ActionResult[];
  screenshot_b64?: string;
  cursor?: { x: number; y: number };
  seat: string;
  pending_checks: { id: string; code: string; message: string }[];
}

export default defineTool({
  approval: never(),
  description:
    "Use my computer's screen (1280×800). Actions run in order; coordinates are pixels of the last full-display screenshot. Returns per-action results and a fresh screenshot. See the computer-use skill before first use.",
  async execute(input) {
    return await hubRpc<ComputerResponse>("computer", input);
  },
  inputSchema: z.object({
    request_id: z
      .string()
      .min(1)
      .describe("Idempotency key: new id per attempt, same id to retry safely"),
    actions: z.array(action).min(1).max(20),
  }),
  toModelOutput(output) {
    const parts: ToolModelOutputPart[] = [];
    const { results } = output;
    const summary = {
      results: results.map(({ image_b64: _i, media_type: _m, ...rest }) => rest),
      cursor: output.cursor,
      seat: output.seat,
      pending_checks: output.pending_checks,
    };
    parts.push(toolOutputPart.text(JSON.stringify(summary)));
    for (const r of results) {
      if (r.image_b64) {
        parts.push(toolOutputPart.file(r.image_b64, { mediaType: r.media_type ?? "image/png" }));
      }
    }
    if (output.screenshot_b64) {
      parts.push(
        toolOutputPart.text("Current screen:"),
        toolOutputPart.file(output.screenshot_b64, { mediaType: "image/png" }),
      );
    }
    return toolOutput.content(parts);
  },
});
