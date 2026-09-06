"use client";

import { DotGrid1x3VerticalIcon } from "blode-icons-react";
import { useEffect, useRef, useState } from "react";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import type { ConversationEntry, Seat, WorkConversation } from "@/lib/seat";
import { isGroupThread, speakerName, threadTime } from "@/lib/threads";
import { safeUrl } from "./chat-message";

/** Long enough to read as live, slow enough that a thread nobody is in is free. */
const POLL_MS = 5000;

/** How far back a thread opens. The hub's page cap is 500; this is a screenful. */
const TAIL = 100;

/**
 * A thread this seat can read and cannot speak into.
 *
 * A Bot's WhatsApp threads are conversations on the same computer as its own,
 * so the workspace lists them; what it must not do is imply you can answer
 * from here. There is no outbound path from a seat to WhatsApp — the bridge
 * sends as the Bot, in reply to a message addressed to it — so this pane has
 * no composer rather than one that fails, and says why in a line at the foot.
 *
 * Read-only is also the safe default for the group: 122 people are on the
 * other side of it, and "the operator can type into the community chat as the
 * Bot" is a decision to make deliberately, not one to inherit from a layout.
 */
export function ThreadTranscript({
  conversation,
  onOpenBots,
  seat,
  subtitle,
  title,
}: {
  conversation: WorkConversation;
  /** Phone only: the thread list is a drawer rather than a rail. */
  onOpenBots?: () => void;
  seat: Seat;
  subtitle?: string;
  title: string;
}): React.ReactElement {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Seeded once, from the tail this thread had when it was opened. Kept in a
  // ref so the poll below advances it without re-running the effect, and so a
  // refreshed `last_seq` from the list does not reset the transcript.
  const cursor = useRef(String(Math.max(0, conversation.last_seq - TAIL)));
  const { id } = conversation;

  useEffect(() => {
    let live = true;
    let running = false;
    const tick = async () => {
      if (running) {
        return;
      }
      running = true;
      try {
        const { entries: page } = await seat.occurrences(id, cursor.current);
        if (!live) {
          return;
        }
        const tail = page.at(-1);
        if (tail) {
          cursor.current = String(tail.seq);
          setEntries((prev) => [...prev, ...page]);
        }
        setProblem(null);
      } catch (error) {
        if (live) {
          setProblem(error instanceof Error ? error.message : "Could not read this thread.");
        }
      } finally {
        running = false;
        if (live) {
          setLoading(false);
        }
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [id, seat]);

  const named = isGroupThread(conversation);

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-border border-b px-4 py-3">
        {onOpenBots && (
          <Button
            aria-label="Threads"
            className="-ml-1 size-11 lg:hidden"
            onClick={onOpenBots}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <DotGrid1x3VerticalIcon />
          </Button>
        )}
        <div className="min-w-0">
          <h2 className="min-w-0 truncate font-semibold text-sm">{title}</h2>
          {subtitle && <p className="truncate text-muted-foreground text-xs">{subtitle}</p>}
        </div>
        {problem && (
          <output className="ml-auto min-w-0 truncate text-destructive text-xs" title={problem}>
            {problem}
          </output>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          aria-label={`Thread with ${title}`}
          className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6"
          role="log"
        >
          {entries.length === 0 && (
            <p className="py-16 text-center text-muted-foreground text-sm">
              {loading ? "Reading this thread from the computer…" : "Nothing has been said here."}
            </p>
          )}
          {entries.map((entry) => (
            <Line conversation={conversation} entry={entry} key={entry.id} named={named} />
          ))}
        </div>
      </div>

      {/* Where the composer would be, saying what is there instead. A pane
          that just ends is read as broken; this one is read as read-only. */}
      <p className="shrink-0 border-border border-t px-4 py-3 text-center text-muted-foreground text-xs">
        This thread is on WhatsApp. Replies are sent by the Bot when it is messaged there.
      </p>
    </section>
  );
}

function Line({
  conversation,
  entry,
  named,
}: {
  conversation: WorkConversation;
  entry: ConversationEntry;
  /** Label who spoke, which is only worth doing where it could be anyone. */
  named: boolean;
}): React.ReactElement {
  const mine = entry.author?.kind === "bot";
  const who = named ? speakerName(conversation, entry.author ?? { kind: "system" }) : "";
  // An unanswered request is not the same line as an answered one: the first
  // is the thread waiting on a person, and saying so is the whole point of it.
  const text =
    entry.kind === "secret_request"
      ? `Asked for ${entry.label || "a secret"}${entry.provided ? "" : " — still waiting"}`
      : (entry.text ?? "");
  const images = (entry.images ?? [])
    .map((url) => safeUrl(url, true))
    .filter((url): url is string => Boolean(url));

  return (
    <Message align={mine ? "end" : "start"}>
      <MessageContent>
        {who && <MessageHeader>{who}</MessageHeader>}
        <Bubble
          align={mine ? "end" : "start"}
          variant={entry.kind === "secret_request" ? "outline" : mine ? "default" : "muted"}
        >
          {text && (
            <BubbleContent className="whitespace-pre-wrap leading-normal">{text}</BubbleContent>
          )}
          {images.map((url) => (
            <img
              alt="Attachment"
              className="max-h-64 w-auto max-w-full rounded-xl border border-border"
              key={url}
              src={url}
            />
          ))}
        </Bubble>
        <MessageHeader className="text-[11px]">{threadTime(entry.at)}</MessageHeader>
      </MessageContent>
    </Message>
  );
}
