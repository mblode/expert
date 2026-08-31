import { defineTool, toolOutput, toolOutputPart, type ToolModelOutputPart } from "eve/tools";
import { z } from "zod";
import { hubRpc } from "../lib/hub";

const action = z
  .object({
    type: z.enum([
      "screenshot",
      "click",
      "double_click",
      "scroll",
      "keypress",
      "type",
      "move",
      "drag",
      "wait",
      "zoom",
      "request_takeover",
    ]),
  })
  .catchall(z.unknown());

type ActionResult = {
  kind: "ok" | "error" | "skipped";
  image_b64?: string;
  media_type?: string;
  [k: string]: unknown;
};

type ComputerResponse = {
  results: ActionResult[];
  screenshot_b64?: string;
  cursor?: { x: number; y: number };
  seat: string;
  pending_checks: { id: string; code: string; message: string }[];
};

export default defineTool({
  description:
    "Use my computer's screen (1280×800). Actions run in order; coordinates are pixels of the last full-display screenshot. Returns per-action results and a fresh screenshot. See the computer-use skill before first use.",
  inputSchema: z.object({
    request_id: z.string().min(1).describe("Idempotency key — new id per attempt, same id to retry safely"),
    actions: z.array(action).min(1).max(20),
  }),
  async execute(input) {
    return await hubRpc<ComputerResponse>("computer", input);
  },
  // The model sees the results as text and every image as vision input.
  toModelOutput(output) {
    const parts: ToolModelOutputPart[] = [];
    const summary = {
      results: output.results.map(({ image_b64: _i, media_type: _m, ...rest }: ActionResult) => rest),
      cursor: output.cursor,
      seat: output.seat,
      pending_checks: output.pending_checks,
    };
    parts.push(toolOutputPart.text(JSON.stringify(summary)));
    for (const r of output.results) {
      if (r.image_b64) {
        parts.push(toolOutputPart.file(r.image_b64, { mediaType: r.media_type ?? "image/png" }));
      }
    }
    if (output.screenshot_b64) {
      parts.push(toolOutputPart.text("Current screen:"));
      parts.push(toolOutputPart.file(output.screenshot_b64, { mediaType: "image/png" }));
    }
    return toolOutput.content(parts);
  },
});
