"use client";

import { PlusIcon, SearchIcon } from "blode-icons-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { BotMark } from "@/components/bot-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BotProfile, Screen, SeatState, WorkConversation } from "@/lib/seat";
import type { ThreadRow } from "@/lib/threads";
import { threadRows, threadTime } from "@/lib/threads";
import { cn } from "@/lib/utils";

/**
 * What the seat is doing on that screen, in the sidebar's words.
 *
 * This used to be the row's only subtitle, because the roster was screens and
 * seat states and a message preview would have had to be invented. The hub
 * reports the tail of every conversation now, so the last thing said is the
 * subtitle and this is the fallback for a thread with nothing in it yet.
 *
 * The dot stays either way: `WAITING` is a Bot stopped in front of a screen
 * waiting for a person, and that must not be hidden behind whatever it said
 * before it stopped.
 *
 * `AGENT` says who holds the seat, which is not the same as who is running.
 * It read "Working" back when every Bot's Eve started at boot, so the two were
 * the same sentence. Bots sleep now, and the wire carries no liveness, so on a
 * roster of eight that word claimed eight running agents when one was up and
 * seven were stopped. Saying what the state actually is costs nothing and is
 * true whether the Bot is mid-turn or asleep; a roster that can say "asleep"
 * needs the hub to report it, which is a contract change, not a label.
 */
const STATE_LABEL: Record<SeatState, string> = {
  AGENT: "Has the seat",
  HUMAN: "You have the seat",
  WAITING: "Needs you",
};

const STATE_DOT: Record<SeatState, string> = {
  AGENT: "bg-emerald-400",
  HUMAN: "bg-sky-400",
  WAITING: "bg-amber-400",
};

/**
 * The left column is a chat list: every thread on this computer, most recent
 * first, the way the phone this Bot answers on shows the same threads.
 *
 * A Bot has one thread per route it speaks on — its own, the WhatsApp DM it
 * answers, the group it is tagged in — and they are all conversations on the
 * same computer, so listing screens hid two of the three. The rows a screen
 * backs still carry its number and its seat state, because opening one is
 * still how you get to that screen.
 */
export function BotSidebar({
  computerId,
  computers,
  conversations,
  display,
  loading,
  onNewBot,
  onSelectThread,
  onSignOut,
  onSwitchComputer,
  profiles,
  screens,
  selectedKey,
  userEmail,
}: {
  computerId: string;
  computers: { id: string; label: string }[];
  /** From the hub. Empty on a seat that may not list them, which degrades to
      one row per screen rather than to an empty column. */
  conversations: WorkConversation[];
  display: number;
  /** The roster has not answered yet, which is not the same as having none. */
  loading?: boolean;
  /** Absent on a hub that cannot make one (an older build, or no owner seat). */
  onNewBot?: () => void;
  onSelectThread: (row: ThreadRow) => void;
  onSignOut: () => void;
  onSwitchComputer: (id: string) => void;
  /** By Bot id, from the roster. Empty until it answers. */
  profiles: Record<string, BotProfile>;
  screens: Screen[];
  /** The open thread, when it is one the screen number does not identify. */
  selectedKey?: string;
  userEmail?: string;
}): React.ReactElement {
  const [query, setQuery] = useState("");

  const rows = useMemo(
    () => threadRows(conversations, screens, profiles),
    [conversations, profiles, screens],
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return rows;
    }
    // What the row says is what a search has to match: the name of whoever it
    // is with, what was last said, and still the Bot's id, because that is
    // what the computer calls it.
    return rows.filter((row) =>
      `${row.title} ${row.preview ?? ""} ${row.botId}`.toLowerCase().includes(needle),
    );
  }, [query, rows]);

  const stateOf = useMemo(() => new Map(screens.map((s) => [s.bot_id, s.state])), [screens]);

  const current = computers.find((c) => c.id === computerId);

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <div className="flex flex-col gap-3 p-3">
        {/* The computer, not a nav label: an account is bound to one, and an
            operator with more than one needs to know which they are driving.
            One control, not a heading beside a switcher saying the same word:
            with a single computer it is a heading, and with several the
            switcher is the heading. */}
        <div className="flex h-8 items-center px-1">
          {computers.length > 1 ? (
            <select
              aria-label="Computer"
              className="-mx-1 max-w-full truncate rounded-md bg-transparent px-1 py-0.5 font-semibold text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => onSwitchComputer(event.target.value)}
              value={computerId}
            >
              {computers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="truncate font-semibold text-sm">{current?.label ?? "Computer"}</span>
          )}
          {onNewBot && (
            <Button
              aria-label="New Bot"
              className="-mr-1 ml-auto size-8 shrink-0 pointer-coarse:size-11"
              onClick={onNewBot}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <PlusIcon />
            </Button>
          )}
        </div>

        <div className="relative">
          <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Search threads"
            className="h-9 rounded-lg pl-9"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            type="search"
            value={query}
          />
        </div>
      </div>

      <nav aria-label="Threads" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <ul className="flex flex-col gap-0.5">
          {matches.map((row) => {
            // With nothing else open the screen is the selection, which keeps
            // the highlight right when the rail changes it from beside here.
            const active = selectedKey
              ? row.key === selectedKey
              : row.live && row.display === display;
            const state = stateOf.get(row.botId);
            const when = threadTime(row.at);
            return (
              <li key={row.key}>
                <button
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                  )}
                  onClick={() => onSelectThread(row)}
                  type="button"
                >
                  <BotMark botId={row.botId} profile={profiles[row.botId]} size="xl" />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-semibold text-[15px] leading-tight">
                        {row.title}
                      </span>
                      {/* The Bot's own label, as a chip, and only on its own
                          thread: on a roster of eight specialists "SEO and
                          growth" is what tells them apart, and on a thread
                          with someone else it is not what the row is about.
                          Capped and shrinkable, because the label runs to 64
                          characters and an unshrinkable chip pushed the rest
                          of the row out rather than truncating itself. */}
                      {row.live && profiles[row.botId]?.title && (
                        <span className="min-w-0 max-w-24 truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {profiles[row.botId]?.title}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        {when || (row.display ? `screen ${row.display}` : "")}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                      {state && (
                        <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[state])} />
                      )}
                      <span className="truncate">
                        {row.preview ?? (state ? STATE_LABEL[state] : "No messages yet")}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {/* An `output`, so a search that empties the list is announced:
            filtering happens while typing, and focus never leaves the field. */}
        {matches.length === 0 && (
          <output className="flex flex-col items-center gap-2 px-3 py-6 text-center">
            <p className="text-muted-foreground text-sm">
              {loading
                ? "Reading the roster from the computer…"
                : rows.length === 0
                  ? "No bots on this computer yet."
                  : `No thread matches “${query}”.`}
            </p>
            {rows.length > 0 && (
              <Button onClick={() => setQuery("")} size="xs" type="button" variant="ghost">
                Clear search
              </Button>
            )}
          </output>
        )}
      </nav>

      <div className="flex flex-col gap-1 border-sidebar-border border-t p-2">
        {/* The sidebar is a drawer below `lg`, so the footer is thumbed rather
            than clicked: both controls grow to the touch floor there. */}
        <Button
          className="justify-start pointer-coarse:h-11"
          render={<Link href="/channels/whatsapp" />}
          size="sm"
          variant="ghost"
        >
          Channels
        </Button>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {userEmail ?? "Signed in"}
          </span>
          <Button
            className="pointer-coarse:h-11"
            onClick={onSignOut}
            size="xs"
            type="button"
            variant="ghost"
          >
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
