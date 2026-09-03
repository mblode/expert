import { defineTool } from "eve/tools";
import { z } from "zod";
import { hubRpc } from "../hub.ts";

export default defineTool({
  description:
    "Say something to the human. This is the ONLY thing they see, all your other text is a private scratchpad, so a turn that ends without a send is silence. Reply with a short text send before you start work, then send again with the result: acknowledging is not delivering. A widget or secret_request ENDS the turn, stop and wait; sending again before they answer fails.",
  // `ctx.session.auth.current` is the verified inbound principal, which is
  // route auth and not a prompt: eve's own multi-tenant guidance is that a
  // prompt asking for another tenant cannot change it. Absent (the eve TUI,
  // the seat's `/eve/v1` proxy) means the Bot's seat thread, unchanged.
  async execute(input, ctx) {
    const turn = ctx.session.auth.current?.attributes.turn;
    return await hubRpc<{
      conversation_id?: string;
      occurrence_id: string;
      turn_ended: boolean;
    }>("sendMessage", input, typeof turn === "string" ? turn : undefined);
  },
  inputSchema: z.object({
    kind: z.enum(["text", "widget", "secret_request"]),
    text: z
      .string()
      .optional()
      .describe("kind=text. One bubble. Several short sends beat one long one."),
    images: z
      .array(z.string())
      .optional()
      .describe("kind=text. Base64 PNGs shown beside the text."),
    prompt: z.string().optional().describe("kind=widget or secret_request. The question."),
    options: z
      .array(z.string())
      .optional()
      .describe("kind=widget. 1-6 real choices. Ends the turn."),
    label: z
      .string()
      .optional()
      .describe(
        "kind=secret_request. What the masked field holds, e.g. 'GitHub 2FA code'. The value goes to my clipboard and never reaches you, paste it, do not expect to read it. Ends the turn.",
      ),
  }),
});
