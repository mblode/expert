import { ComputerUseIcon, DotGrid1x3VerticalIcon, ShareScreenIcon } from "blode-icons-react";
import { useEveAgent } from "eve/react";
import type { EveMessage } from "eve/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { BotMark } from "@/components/bot-mark";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
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
import { signInPrompt, toolLabel } from "@/lib/onboarding";
import { apiBase } from "../lib/seat";
import type { BotProfile, Seat, SeatState } from "../lib/seat";
import { loadSession, saveSession } from "../lib/storage";
import { ChatComposer } from "./chat-composer";
import { ChatMessage } from "./chat-message";
import type { Answer } from "./chat-message";

/** Openers, not a menu: past three the empty state is a form to fill in. */
const OPENERS = 3;

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
  offline,
  onOpenBots,
  onOpenScreen,
  onOpenSettings,
  onRetry,
  profile,
  screenNeedsYou = false,
  seatState,
  seat,
  tools,
}: {
  botId: string;
  /** The hub is unreachable. Reported here, not over the composer. */
  offline?: string | null;
  /** Phone only: the roster and the screen are drawers rather than rails. */
  onOpenBots?: () => void;
  onOpenScreen?: () => void;
  /** Who this Bot is, edited from the header beside its name. */
  onOpenSettings?: () => void;
  onRetry?: () => void;
  /** From the roster; absent until it answers. */
  profile?: BotProfile;
  screenNeedsYou?: boolean;
  /** This Bot's own screen, so the conversation can say when it is stuck. */
  seatState?: SeatState;
  seat: Seat;
  /**
   * The tools this account named at the first run. They become the empty
   * conversation's openers, which is the whole reason that question is asked:
   * a new computer's Chrome is signed into nothing, and signing into one thing
   * with the human at the keyboard is both the most useful first turn and the
   * one that teaches what the seat is for.
   */
  tools: string[];
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
            className="-ml-1 size-11 lg:hidden"
            onClick={onOpenBots}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <DotGrid1x3VerticalIcon />
          </Button>
        )}
        {/* Mark, name and the way into settings are one control, not three
            things that happen to sit together: the header names who you are
            talking to, so tapping the name is how you look at them. */}
        <button
          className="-ml-1 flex min-w-0 items-center gap-2 rounded-full py-1 pr-3 pl-1 text-left transition-colors hover:bg-accent disabled:hover:bg-transparent"
          disabled={!onOpenSettings}
          onClick={onOpenSettings}
          type="button"
        >
          <BotMark botId={botId} profile={profile} size="md" />
          <h2 className="min-w-0 truncate font-semibold text-sm">{profile?.name || botId}</h2>
        </button>
        {/* The connection error belongs beside the Bot it is about. It used to
            be a viewport-fixed banner, which landed on the composer: the one
            control you reach for when the computer stops answering. */}
        {offline ? (
          <output className="flex min-w-0 items-center gap-2 text-destructive text-xs">
            <span className="truncate" title={offline}>
              {offline}
            </span>
            {onRetry && (
              <Button
                className="pointer-coarse:h-11"
                onClick={onRetry}
                size="xs"
                type="button"
                variant="outline"
              >
                Retry
              </Button>
            )}
          </output>
        ) : (
          down && <output className="shrink-0 text-amber-300 text-xs">not running</output>
        )}
        {onOpenScreen && (
          <Button
            aria-label="Screen"
            className="relative -mr-1 ml-auto size-11 lg:hidden"
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
              aria-label={`Conversation with ${profile?.name || botId}`}
              className="mx-auto w-full max-w-3xl gap-5 px-4 py-6"
              // `role="log"` over `aria-live` on the same element: both are
              // polite, but a live region re-reads its whole subtree and this
              // one is the entire transcript, so every streamed token
              // announced the conversation again from the top. A log
              // announces only what was appended.
              role="log"
            >
              {messages.length === 0 && !resuming && (
                <Empty className="py-16">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ComputerUseIcon />
                    </EmptyMedia>
                    <EmptyTitle>
                      {down
                        ? `Eve is not running for ${profile?.name || botId}`
                        : `Message ${profile?.name || botId}`}
                    </EmptyTitle>
                    <EmptyDescription>
                      {down
                        ? "The computer starts one Eve process per Bot on the roster. This one is not answering yet."
                        : "It drives its own screen, and asks for the seat when it gets stuck."}
                    </EmptyDescription>
                  </EmptyHeader>
                  {/* One action, and only where one is real. On the `down`
                      branch the Eve process is not running on the box and
                      nothing the browser can offer restarts it, so a button
                      there would be an affordance that does not work. */}
                  {!down && (
                    <EmptyContent>
                      {tools.length > 0 && (
                        <div className="flex flex-wrap justify-center gap-2">
                          {tools.slice(0, OPENERS).map((tool) => (
                            <Button
                              key={tool}
                              onClick={() => send(signInPrompt(tool))}
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              Sign in to {toolLabel(tool)}
                            </Button>
                          ))}
                        </div>
                      )}
                      <Button
                        onClick={() => send("Take a screenshot and tell me what is on the screen.")}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Show me the screen
                      </Button>
                    </EmptyContent>
                  )}
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

      {/* What the iOS client shows as a Computer card in the thread: the Bot
          has stopped and is waiting for a person on its screen. On a phone the
          screen is a drawer, so the card is how you know to open it; on a wide
          screen the rail is already showing the same thing beside this. */}
      {seatState === "WAITING" && onOpenScreen && (
        <div className="mx-auto w-full max-w-3xl px-4 pb-3 lg:hidden">
          <div className="flex items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
            <ShareScreenIcon className="size-5 shrink-0 text-amber-200" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm">Computer</p>
              <p className="text-muted-foreground text-xs">
                {profile?.name || botId} is stuck and needs you on its screen.
              </p>
            </div>
            <Button onClick={onOpenScreen} size="sm" type="button" variant="warning">
              Take over
            </Button>
          </div>
        </div>
      )}

      <ChatComposer
        botName={profile?.name || botId}
        busy={busy}
        disabled={resuming}
        onSend={send}
        onStop={() => void agent.cancel().catch(() => {})}
      />
    </section>
  );
}
