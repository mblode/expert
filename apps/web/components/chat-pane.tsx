import { useEveAgent } from "eve/react";
import type { EveMessage } from "eve/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { apiBase } from "../lib/seat";
import type { Seat } from "../lib/seat";
import { loadSession, saveSession } from "../lib/storage";
import { ChatComposer } from "./chat-composer";
import { ChatMessage } from "./chat-message";
import type { Answer } from "./chat-message";

const hasVisibleContent = (message: EveMessage): boolean =>
  message.parts.some((part) =>
    part.type === "text"
      ? Boolean(part.text)
      : part.type === "dynamic-tool" || part.type === "authorization",
  );

function eveIsDown(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  return /DAEMON_DOWN|not running|Failed to fetch|NetworkError|Load failed|ECONNREFUSED/i.test(
    message,
  );
}

/**
 * The conversation with Eve, over the hub's `/eve/v1` proxy: same seat token
 * as the rest of the app, so pairing is the only credential. `botId` selects
 * which guest Eve process owns this screen (`x-computer-bot`).
 *
 * The session cursor is persisted per bot, so a reload replays the same
 * durable session rather than starting a new one.
 */
export function ChatPane({ botId, seat }: { botId: string; seat: Seat }): React.ReactElement {
  // Read once: the hook builds its store on first render and keeps it.
  // Remount this pane (`key={botId}`) when the selected Bot changes.
  const initialSession = useMemo(() => loadSession(botId), [botId]);
  // The hook captures its options on first render; the latest credentials
  // reach it through refs that are updated after each commit.
  const tokenRef = useRef(seat.token);
  const botRef = useRef(botId);
  useEffect(() => {
    tokenRef.current = seat.token;
    botRef.current = botId;
  });

  const agent = useEveAgent({
    auth: { bearer: () => tokenRef.current },
    headers: () => ({ "x-computer-bot": botRef.current }),
    host: apiBase(seat.hubUrl),
    initialSession,
    onSessionChange: (session) => saveSession(session, botRef.current),
    resume: initialSession !== undefined,
  });

  const [lastSent, setLastSent] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const busy = agent.status === "submitted" || agent.status === "streaming";
  const resuming = agent.status === "resuming";
  const { messages } = agent.data;
  const down = eveIsDown(agent.error?.message);

  // Follow the stream, unless the reader has scrolled up to read something.
  useEffect(() => {
    if (pinned.current && messages.length > 0) {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    }
  }, [messages]);

  const send = (text: string) => {
    setLastSent(text);
    void agent.send(text).catch(() => {});
  };

  const answer = ({ optionId, requestId, text }: Answer) => {
    void agent
      .respond([{ requestId, ...(optionId ? { optionId } : { text: text ?? "" }) }])
      .catch(() => {});
  };

  const last = messages.at(-1);
  const thinking = busy && (!last || last.role === "user" || !hasVisibleContent(last));
  const statusLabel = down
    ? "not running"
    : resuming
      ? "catching up…"
      : busy
        ? "working…"
        : "ready";

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-edge max-lg:border-t lg:border-l">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <h2 className="text-sm font-medium">Eve</h2>
        <output className={`text-xs ${down ? "text-amber-300" : "text-mute"}`}>
          {statusLabel}
        </output>
        <span className="truncate text-xs text-mute">{botId}</span>
        <Button
          className="ml-auto"
          onClick={() => {
            agent.reset();
            saveSession(undefined, botId);
          }}
          size="xs"
          type="button"
          variant="outline"
        >
          New chat
        </Button>
      </header>

      <div
        aria-live="polite"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
        }}
        ref={scroller}
      >
        {down && messages.length === 0 && !resuming && (
          <p className="pt-8 text-center text-sm text-mute">
            Eve is not running for <span className="text-white">{botId}</span>. The guest starts one
            process per roster bot with <code className="text-xs">eve start</code>.
          </p>
        )}
        {messages.length === 0 && !resuming && !down && (
          <p className="pt-8 text-center text-sm text-mute">
            Ask Eve to do something on the box. It drives its own screen and asks for the seat when
            it gets stuck.
          </p>
        )}
        {messages.map((message) => (
          <ChatMessage disabled={busy} key={message.id} message={message} onAnswer={answer} />
        ))}
        {thinking && <p className="text-xs text-mute">Thinking…</p>}
      </div>

      {agent.error && (
        <div className="flex flex-wrap items-center gap-2 border-t border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
          <span className="min-w-0 break-words">{agent.error.message}</span>
          {lastSent && (
            <Button
              className="ml-auto"
              onClick={() => send(lastSent)}
              size="xs"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          )}
        </div>
      )}

      <ChatComposer
        busy={busy}
        disabled={resuming}
        onSend={send}
        onStop={() => void agent.cancel().catch(() => {})}
      />
    </section>
  );
}
