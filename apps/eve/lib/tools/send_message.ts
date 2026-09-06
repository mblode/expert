import { AGENT_MESSAGE_KINDS } from "@computer/shared";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { hubRpc } from "../hub.ts";

export default defineTool({
  description:
    "Say something to the human. Reply briefly before work and with the result. kind=link opens owner-authenticated computer control, plugin setup or cloud coding. Repeat the returned URL in a WhatsApp final reply; it grants no access without sign-in. A secret_request ENDS the turn; stop and wait. Ask a question as text. Never ask for credentials in chat.",
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
    routine: z
      .object({
        operation: z.enum(["list", "save", "pause", "resume"]),
        id: z.string().optional(),
        base_revision: z.number().int().nonnegative().optional(),
        cron: z.string().optional(),
        timezone: z.string().optional(),
        prompt: z.string().max(4000).optional(),
      })
      .strict()
      .optional()
      .describe(
        "kind=routine. List before changing a routine; save a five-field cron, IANA timezone and instruction. Read pending and next_local before claiming activation. Pause prevents future runs.",
      ),
    configuration: z
      .object({
        operation: z.enum(["read", "replace", "undo"]),
        base_revision: z.number().int().nonnegative().optional(),
        instructions: z.string().max(10_000).optional(),
        memory: z.array(z.string().max(500)).max(50).optional(),
        skills: z
          .array(
            z.object({ id: z.string(), description: z.string(), markdown: z.string() }).strict(),
          )
          .max(20)
          .optional(),
      })
      .strict()
      .optional()
      .describe(
        "kind=configure. Read the current revision before replacing owner instructions, memory or procedures. Undo creates a new revision.",
      ),
    kind: z.enum(AGENT_MESSAGE_KINDS),
    repo: z
      .string()
      .optional()
      .describe("kind=code. Exact GitHub repository URL enabled by the owner. text is the brief."),
    destination: z
      .enum(["computer", "plugins", "code"])
      .optional()
      .describe("kind=link. Opens this Bot's work on the owner's authenticated account."),
    text: z
      .string()
      .optional()
      .describe("kind=text. One bubble. Several short sends beat one long one."),
    images: z
      .array(z.string())
      .optional()
      .describe("kind=text. Base64 PNGs shown beside the text."),
    prompt: z.string().optional().describe("kind=secret_request. The question."),
    label: z
      .string()
      .optional()
      .describe(
        "kind=secret_request. What the masked field holds, e.g. 'GitHub 2FA code'. The value goes to my clipboard and never reaches you, paste it, do not expect to read it. Ends the turn.",
      ),
  }),
});
