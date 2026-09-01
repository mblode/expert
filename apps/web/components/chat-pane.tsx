import { useEveAgent } from "eve/react";
import type { EveMessage } from "eve/react";
import { useEffect, useRef, useState } from "react";

import { apiBase } from "../lib/seat";
import type { Seat } from "../lib/seat";
import { loadSession, saveSession } from "../lib/storage";
import { ChatComposer } from "./chat-composer";
import { ChatMessage } from "./chat-message";
import type { Answer } from "./chat-message";

const hasVisibleContent = (message: EveMessage): boolean =>
  message.parts.some((part) =>
    part.type === "text" ? Boolean(part.text) : part.type === "dynamic-tool" || part.type === "authorization",
  );

/**
 * The conversation with Eve, over the hub's `/eve/v1` proxy — same seat token
 * as the rest of the app, so pairing is the only credential.
 *
 * The session cursor is persisted, so a reload replays the same durable
 * session rather than starting a new one.
 */
export function ChatPane({ seat }: { seat: Seat }): React.ReactElement {
  // Read once: the hook builds its store on first render and keeps it.
  const [initialSession] = useState(loadSession);
  const tokenRef = useRef(seat.token);
  tokenRef.current = seat.token;

  const agent = useEveAgent({
    auth: { bearer: () => tokenRef.current },
    host: apiBase(seat.hubUrl),
    initialSession,
    onSessionChange: saveSession,
    resume: initialSession !== undefined,
  });

  const [lastSent, setLastSent] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const busy = agent.status === "submitted" || agent.status === "streaming";
  const resuming = agent.status === "resuming";
  const messages = agent.data.messages;

  // Follow the stream, unless the reader has scrolled up to read something.
  useEffect(() => {
    if (pinned.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  const send = (text: string) => {
    setLastSent(text);
    void agent.send(text).catch(() => undefined);
  };

  const answer = ({ optionId, requestId, text }: Answer) => {
    void agent.respond([{ requestId, ...(optionId ? { optionId } : { text: text ?? "" }) }]).catch(() => undefined);
  };

  const last = messages.at(-1);
  const thinking = busy && (!last || last.role === "user" || !hasVisibleContent(last));
  // Eve is optional on this box. A down /eve should not paint a red error
  // over the desk — just leave the thread empty.
  const eveQuiet =
    agent.error !== undefined &&
    /DAEMON_DOWN|not running|Failed to fetch|NetworkError|Load failed|ECONNREFUSED/i.test(
      agent.error.message,
    );

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-edge max-lg:border-t lg:border-l">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <h2 className="text-sm font-medium">Eve</h2>
        <span className="text-xs text-mute">
          {eveQuiet ? "" : resuming ? "catching up…" : busy ? "working…" : "ready"}
        </span>
        <button
          className="ml-auto rounded-md border border-edge px-2.5 py-1 text-xs hover:border-accent"
          onClick={() => {
            agent.reset();
            saveSession(undefined);
          }}
          type="button"
        >
          New chat
        </button>
      </header>

      <div
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
        }}
        ref={scroller}
      >
        {messages.length === 0 && !resuming && !eveQuiet && (
          <p className="pt-8 text-center text-sm text-mute">
            Ask Eve to do something on the box. It drives its own screen and asks for the seat
            when it gets stuck.
          </p>
        )}
        {messages.map((message) => (
          <ChatMessage disabled={busy} key={message.id} message={message} onAnswer={answer} />
        ))}
        {thinking && <p className="text-xs text-mute">Thinking…</p>}
      </div>

      {agent.error && !eveQuiet && (
        <div className="flex flex-wrap items-center gap-2 border-t border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
          <span className="min-w-0 break-words">{agent.error.message}</span>
          {lastSent && (
            <button
              className="ml-auto rounded-md border border-red-800 px-2 py-0.5 hover:border-red-400"
              onClick={() => send(lastSent)}
              type="button"
            >
              Retry
            </button>
          )}
        </div>
      )}

      <ChatComposer
        busy={busy}
        disabled={resuming}
        onSend={send}
        onStop={() => void agent.cancel().catch(() => undefined)}
      />
    </section>
  );
}
