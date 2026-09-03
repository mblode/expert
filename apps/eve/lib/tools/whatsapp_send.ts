import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { postEnvelope } from "../bridge.ts";
import type { BridgeDeps, EnvelopeMedia, SendEnvelope } from "../bridge.ts";
import { outboundReply } from "../format-reply.ts";

/**
 * One tool for everything the Bot writes into the WhatsApp chat it is
 * answering: a quoted reply, a reaction, a file.
 *
 * One tool and not one per verb, because the bridge is one envelope
 * (`apps/whatsapp-bridge/src/send-envelope.ts`) with one target allowlist and
 * one rate decision. A tool per verb would be four descriptions in every
 * turn's context and four places for a rule to drift.
 *
 * It is additive, never the reply path. The channel already returns the turn's
 * final text to the bridge and the bridge posts it, so an ordinary answer
 * costs no tool call; this is for the things that response cannot express.
 * That is also why every failure is a value rather than a throw: a dead bridge
 * must not cost the human the answer the model already has.
 *
 * The chat is not an argument. The JID comes from the session, so the model
 * cannot aim a send at another chat, and a group that pastes a JID into the
 * conversation cannot talk this tool into messaging someone else.
 */

/** `reply_to` opt-out: send without quoting anything. */
export const NO_QUOTE = "none";

/** What the tool needs to know about the turn it is running in. */
interface ChatContext {
  jid: string;
  /** Short id of the message being answered, the default quote target. */
  messageId?: string;
  /** Which linked number this arrived on; the bridge routes on it. */
  acct?: string;
}

interface WhatsAppSendInput {
  text?: string;
  react?: string;
  reply_to?: string;
  media?: EnvelopeMedia[];
}

type WhatsAppSendResult =
  | { sent: true; message_ids: string[] }
  | { sent: false; problem: "malformed" | "refused"; reason: string; retry: boolean }
  | { available: false; note: string };

/** Said when the turn is not a WhatsApp turn at all (the eve TUI, a schedule). */
export const NO_CHAT_NOTE = "there is no WhatsApp chat on this turn, so answer in text instead";

const attribute = (
  attributes: Readonly<Record<string, string | readonly string[]>> | undefined,
  key: string,
): string | undefined => {
  const value = attributes?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
};

/**
 * The chat this turn belongs to, from the session's auth attributes, or null
 * on any surface that is not WhatsApp. `groupJid` is the chat JID on both
 * surfaces; the name is historical (in a DM it is the DM's JID).
 */
export const chatFromAttributes = (
  attributes: Readonly<Record<string, string | readonly string[]>> | undefined,
): ChatContext | null => {
  const jid = attribute(attributes, "groupJid");
  if (!jid) {
    return null;
  }
  const messageId = attribute(attributes, "messageId");
  const acct = attribute(attributes, "acct");
  return { jid, ...(messageId ? { messageId } : {}), ...(acct ? { acct } : {}) };
};

/** Clean one caption the same way a reply is cleaned, dropping it when nothing survives. */
const cleanMedia = ({ caption, ...rest }: EnvelopeMedia): EnvelopeMedia => {
  const cleaned = caption ? outboundReply(caption) : "";
  return { ...rest, ...(cleaned ? { caption: cleaned } : {}) };
};

/**
 * Build the envelope, or the malformed result that says why there isn't one.
 *
 * Kept separate from the send so the anchoring and cleaning rules are testable
 * without a bridge, and so a bad call costs no round trip.
 */
export const buildEnvelope = (
  input: WhatsAppSendInput,
  chat: ChatContext,
): { envelope: SendEnvelope } | { error: string } => {
  // The anchor defaults to the message this turn is answering, which is the
  // whole point: the model never has to copy an id out of the untrusted
  // context block, and text into a group is refused outright without one. The
  // same anchor serves a reaction, because "the message being addressed" is
  // one thing in every real send; reacting to A while quoting B is two calls.
  const requested = input.reply_to?.trim();
  const anchor = requested === NO_QUOTE ? undefined : (requested ?? chat.messageId);
  const text = input.text ? outboundReply(input.text) : "";
  const react = input.react?.trim();
  const media = (input.media ?? []).map(cleanMedia);
  if (!(text || react || media.length > 0)) {
    return { error: "nothing to send: pass text, react or media" };
  }
  if (react && !anchor) {
    return {
      error: "a reaction needs a message to sit on: pass reply_to with a message_id from this chat",
    };
  }
  return {
    envelope: {
      jid: chat.jid,
      ...(chat.acct ? { acct: chat.acct } : {}),
      ...(anchor ? { reply_to: anchor } : {}),
      ...(text ? { text } : {}),
      ...(react && anchor ? { react: { emoji: react, to: anchor } } : {}),
      ...(media.length > 0 ? { media } : {}),
    },
  };
};

/**
 * The tool's whole body, given the chat the turn is in. `chat` is null on any
 * non-WhatsApp surface, which degrades rather than throwing so the eve TUI and
 * a schedule keep working with this tool registered.
 */
export const whatsappSend = async (
  input: WhatsAppSendInput,
  chat: ChatContext | null,
  deps: BridgeDeps = {},
): Promise<WhatsAppSendResult> => {
  if (!chat) {
    return { available: false, note: NO_CHAT_NOTE };
  }
  const built = buildEnvelope(input, chat);
  if ("error" in built) {
    // Local refusals are malformed by definition: the input never left here.
    return { problem: "malformed", reason: built.error, retry: true, sent: false };
  }
  const result = await postEnvelope(built.envelope, deps);
  if (result.ok) {
    return { message_ids: result.messageIds, sent: true };
  }
  if (result.kind === "unreachable") {
    return { available: false, note: `${result.reason}, so answer in text instead` };
  }
  // A refusal names the rule that refused it and will name it again on a
  // repeat, so `retry` is false there and true only where new input can help.
  return {
    problem: result.kind,
    reason: result.reason,
    retry: result.kind === "malformed",
    sent: false,
  };
};

const mediaSchema = z.object({
  kind: z.enum(["image", "document"]).describe("document = a file with a name, image = a picture"),
  mime: z.string().describe('e.g. "image/png", "application/pdf"'),
  base64: z
    .string()
    .describe("The file's bytes, base64. `shell` gives you them: base64 -w0 <path>"),
  filename: z.string().optional().describe("Required for a document; WhatsApp shows this name"),
  caption: z.string().optional().describe("A line under the file"),
});

export default defineTool({
  approval: never(),
  description:
    'Write into the WhatsApp chat this turn came from: react to a message, attach a file, or send an extra bubble. An ordinary answer does NOT need this, the text you end the turn with is already sent as the reply. By default it quotes the message you are answering; pass reply_to with another message_id from the chat to answer an earlier one, or reply_to "none" for an unquoted message (a group refuses unquoted text). Read the result: sent:true is done. problem:"malformed" is your input, fix it and call once more. problem:"refused" is a bridge rule or a daily limit, do not call again, mention it in your reply instead. available:false means there is no chat or no bridge here, just answer in text.',
  execute(input: WhatsAppSendInput, ctx: ToolContext): Promise<WhatsAppSendResult> {
    return whatsappSend(input, chatFromAttributes(ctx.session.auth.current?.attributes));
  },
  inputSchema: z.object({
    text: z.string().optional().describe("Plain text. WhatsApp bold is a single *"),
    react: z
      .string()
      .optional()
      .describe("A single emoji to put on the message, e.g. 👍. Nothing else goes in this field"),
    reply_to: z
      .string()
      .optional()
      .describe(
        'A message_id from this chat. Defaults to the message you are answering; "none" sends without a quote',
      ),
    media: z.array(mediaSchema).optional().describe("Files to attach, a few at most"),
  }),
});
