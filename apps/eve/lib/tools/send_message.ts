import { defineTool } from "eve/tools";
import { z } from "zod";
import { hubRpc } from "../hub.ts";

export default defineTool({
  description:
    "Say something to the human. This is the ONLY thing they see — all your other text is a private scratchpad, so a turn that ends without a send is silence. Reply with a short text send before you start work, then send again with the result: acknowledging is not delivering. A widget or secret_request ENDS the turn — stop and wait; sending again before they answer fails.",
  inputSchema: z.object({
    kind: z.enum(["text", "widget", "secret_request"]),
    text: z
      .string()
      .optional()
      .describe("kind=text. One bubble. Several short sends beat one long one."),
    images: z.array(z.string()).optional().describe("kind=text. Base64 PNGs shown beside the text."),
    prompt: z.string().optional().describe("kind=widget or secret_request. The question."),
    options: z
      .array(z.string())
      .optional()
      .describe("kind=widget. 1-6 real choices. Ends the turn."),
    label: z
      .string()
      .optional()
      .describe(
        "kind=secret_request. What the masked field holds, e.g. 'GitHub 2FA code'. The value goes to my clipboard and never reaches you — paste it, do not expect to read it. Ends the turn.",
      ),
  }),
  async execute(input) {
    return await hubRpc<{ occurrence_id: string; turn_ended: boolean }>("sendMessage", input);
  },
});
