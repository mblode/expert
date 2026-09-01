import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRegistry } from "./auth.ts";
import { tokenFromRequest } from "./auth.ts";
import { writeError, writeJson } from "./router.ts";
import type { BotRegistry } from "../service/bots.ts";
import { type ChatEvent, runChat } from "../service/chat.ts";

export type ChatHandlerDeps = {
  bots: BotRegistry;
  auth: AuthRegistry;
  apiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
};

/** SSE chat stream. One agent loop per Bot; the Bot owns exactly one screen. */
export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ChatHandlerDeps,
): Promise<void> {
  const bearer = tokenFromRequest(req);
  deps.auth.verify("seat", bearer);

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let message = "";
  let botId: string | undefined;
  try {
    const body = JSON.parse(chunks.length ? Buffer.concat(chunks).toString("utf8") : "{}") as {
      message?: string;
      bot_id?: string;
    };
    message = body.message ?? "";
    botId = body.bot_id;
  } catch {
    writeJson(res, 400, { error: { code: "VALIDATION", message: "invalid JSON" } });
    return;
  }

  let bot;
  try {
    bot = botId ? deps.bots.byId(botId) : deps.bots.primary();
  } catch (err) {
    writeError(res, err);
    return;
  }
  // Different Bots run concurrently; a second turn on the same Bot is refused.
  if (bot.chatBusy) {
    writeJson(res, 409, { error: { code: "CONFLICT", message: `bot ${bot.id} is busy` } });
    return;
  }
  bot.chatBusy = true;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  try {
    for await (const ev of runChat(
      {
        computer: bot.computer,
        files: bot.files,
        seat: bot.seat,
        apiKey: deps.apiKey,
        baseUrl: deps.llmBaseUrl,
        model: deps.llmModel,
      },
      message,
    )) {
      writeEvent(res, ev);
    }
  } catch (err) {
    // Headers are already out, so writeHead would throw ERR_HTTP_HEADERS_SENT and
    // take the process down. A failed turn is a final SSE event, never a rethrow.
    const message = err instanceof Error ? err.message : "internal";
    writeEvent(res, { type: "error", code: "DAEMON_DOWN", message });
    writeEvent(res, { type: "done" });
  } finally {
    bot.chatBusy = false;
  }
  res.end();
}

function writeEvent(res: ServerResponse, ev: ChatEvent): void {
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}
