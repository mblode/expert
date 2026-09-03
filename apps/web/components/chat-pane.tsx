import { ComputerUseIcon, DotGrid1x3VerticalIcon, ShareScreenIcon } from "blode-icons-react";
import { useEveAgent } from "eve/react";
import type { EveMessage } from "eve/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { BotMark } from "@/components/bot-mark";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { ThinkingIndicator } from "@/components/ui/thinking-indicator";
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
export function ChatPane({
  botId,
  onOpenBots,
  onOpenScreen,
  screenNeedsYou = false,
  seat,
}: {
  botId: string;
  /** Phone only: the roster and the screen are drawers rather than rails. */
  onOpenBots?: () => void;
  onOpenScreen?: () => void;
  screenNeedsYou?: boolean;
  seat: Seat;
}): React.ReactElement {
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

  const busy = agent.status === "submitted" || agent.status === "streaming";
  const resuming = agent.status === "resuming";
  const { messages } = agent.data;
  const down = eveIsDown(agent.error?.message);

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

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-border border-b px-3 lg:px-4">
        {onOpenBots && (
          <Button
            aria-label="Bots"
            className="-ml-1 lg:hidden"
            onClick={onOpenBots}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <DotGrid1x3VerticalIcon />
          </Button>
        )}
        <BotMark botId={botId} size="md" />
        <h2 className="min-w-0 truncate font-semibold text-sm">{botId}</h2>
        {down && <output className="shrink-0 text-amber-300 text-xs">not running</output>}
        <Button
          className="ml-auto"
          onClick={() => {
            agent.reset();
            saveSession(undefined, botId);
          }}
          size="xs"
          type="button"
          variant="ghost"
        >
          New chat
        </Button>
        {onOpenScreen && (
          <Button
            aria-label="Screen"
            className="relative -mr-1 lg:hidden"
            onClick={onOpenScreen}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ShareScreenIcon />
            {screenNeedsYou && (
              <span className="absolute top-1 right-1 size-1.5 rounded-full bg-amber-400" />
            )}
          </Button>
        )}
      </header>

      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent
              aria-busy={agent.status === "streaming"}
              aria-live="polite"
              className="mx-auto w-full max-w-3xl gap-5 px-4 py-6"
            >
              {messages.length === 0 && !resuming && (
                <Empty className="py-16">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ComputerUseIcon />
                    </EmptyMedia>
                    <EmptyTitle>
                      {down ? `Eve is not running for ${botId}` : `Message ${botId}`}
                    </EmptyTitle>
                    <EmptyDescription>
                      {down
                        ? "The computer starts one Eve process per Bot on the roster. Check that it came up."
                        : "It drives its own screen, and asks for the seat when it gets stuck."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}

              {messages.map((message) => (
                <MessageScrollerItem
                  // `content-visibility: auto` is the scroller's default and
                  // wrong for this transcript: it applies containment that
                  // stops a collapsed tool chain measuring `height: auto` when
                  // it opens, so expanding one gave an empty rectangle. These
                  // items also change height after mount (a chain opens, a
                  // screenshot loads), which is what the intrinsic-size
                  // placeholder is worst at.
                  className="[content-visibility:visible]"
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === "user"}
                >
                  <ChatMessage disabled={busy} message={message} onAnswer={answer} />
                </MessageScrollerItem>
              ))}

              {thinking && (
                <MessageScrollerItem>
                  <ThinkingIndicator className="px-0" />
                </MessageScrollerItem>
              )}

              {agent.error && !down && (
                <Marker>
                  <MarkerContent className="text-destructive">{agent.error.message}</MarkerContent>
                  {lastSent && (
                    <Button onClick={() => send(lastSent)} size="xs" type="button" variant="ghost">
                      Retry
                    </Button>
                  )}
                </Marker>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <ChatComposer
        botId={botId}
        busy={busy}
        disabled={resuming}
        onSend={send}
        onStop={() => void agent.cancel().catch(() => {})}
      />
    </section>
  );
}
