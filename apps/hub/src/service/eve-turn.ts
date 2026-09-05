import { ComputerError, outboundReply } from "@computer/shared";
import type { ConversationRegistry } from "./conversations.ts";
import type { TurnService } from "./turns.ts";
import { EVE_HUB_SECRET_HEADER } from "../host/eve.ts";

/** One canonical recorded voice for live messages and scheduled owner work. */
export async function runEveTurn(input: {
  url: string;
  secret?: string;
  body: Uint8Array;
  bot: string;
  conversation: string;
  turn: string;
  turns: TurnService;
  conversations: ConversationRegistry;
}): Promise<{ status: number; body: string }> {
  const release = input.turns.keepAlive(input.turn, input.bot);
  try {
    const upstream = await fetch(input.url, {
      body: Buffer.from(input.body),
      headers: {
        "content-type": "application/json",
        ...(input.secret ? { [EVE_HUB_SECRET_HEADER]: input.secret } : {}),
        "x-computer-turn": input.turn,
      },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(30 * 60_000),
    });
    let text = await upstream.text();
    if (Buffer.byteLength(text) > 64 * 1024)
      throw new ComputerError("DAEMON_DOWN", "WhatsApp reply exceeds the response limit");
    if (upstream.ok) {
      const payload = JSON.parse(text) as { reply?: unknown };
      if (typeof payload.reply !== "string")
        throw new ComputerError("DAEMON_DOWN", "invalid WhatsApp reply");
      const delivery = outboundReply(
        input.conversations.deliveryText(input.conversation, input.turn) ?? payload.reply,
      );
      text = JSON.stringify({ reply: delivery });
      input.conversations.recordDelivery(
        input.conversation,
        { bot: input.bot, kind: "bot" },
        { images: [], kind: "text", text: delivery },
        input.turn,
      );
    }
    return { status: upstream.status, body: text };
  } finally {
    release();
  }
}
