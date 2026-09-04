"use client";

import { PlusIcon, SearchIcon } from "blode-icons-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { BotMark } from "@/components/bot-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BotProfile, Screen, SeatState } from "@/lib/seat";
import { cn } from "@/lib/utils";

/**
 * What the seat is doing on that screen, in the sidebar's words.
 *
 * This is the row's only subtitle, and it is deliberately the truth the hub
 * reports rather than a preview of the last message: the roster is screens and
 * seat states, and a message preview would have to be invented.
 */
const STATE_LABEL: Record<SeatState, string> = {
  AGENT: "Working",
  HUMAN: "You have the seat",
  WAITING: "Needs you",
};

const STATE_DOT: Record<SeatState, string> = {
  AGENT: "bg-emerald-400",
  HUMAN: "bg-sky-400",
  WAITING: "bg-amber-400",
};

export function BotSidebar({
  computerId,
  computers,
  display,
  onDisplayChange,
  onNewBot,
  onSignOut,
  onSwitchComputer,
  profiles,
  screens,
  userEmail,
}: {
  computerId: string;
  computers: { id: string; label: string }[];
  display: number;
  onDisplayChange: (display: number) => void;
  /** Absent on a hub that cannot make one (an older build, or no owner seat). */
  onNewBot?: () => void;
  onSignOut: () => void;
  onSwitchComputer: (id: string) => void;
  /** By Bot id, from the roster. Empty until it answers. */
  profiles: Record<string, BotProfile>;
  screens: Screen[];
  userEmail?: string;
}): React.ReactElement {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return screens;
    }
    // The name is what the row says, so it is what a search has to match; the
    // id still does too, because that is what the computer calls the Bot.
    return screens.filter((s) =>
      `${s.bot_id} ${profiles[s.bot_id]?.name ?? ""}`.toLowerCase().includes(needle),
    );
  }, [profiles, query, screens]);

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
            aria-label="Search bots"
            className="h-9 rounded-lg pl-9"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            type="search"
            value={query}
          />
        </div>
      </div>

      <nav aria-label="Bots" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <ul className="flex flex-col gap-0.5">
          {matches.map((screen) => {
            const active = screen.display === display;
            return (
              <li key={screen.display}>
                <button
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                  )}
                  onClick={() => onDisplayChange(screen.display)}
                  type="button"
                >
                  <BotMark botId={screen.bot_id} profile={profiles[screen.bot_id]} size="xl" />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-semibold text-[15px] leading-tight">
                        {profiles[screen.bot_id]?.name || screen.bot_id}
                      </span>
                      {/* The Bot's own label, as a chip: on a roster of eight
                          specialists "SEO and growth" is what tells them
                          apart, and it is already in the profile. */}
                      {profiles[screen.bot_id]?.title && (
                        <span className="shrink-0 truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {profiles[screen.bot_id]?.title}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        screen {screen.display}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                      <span
                        className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[screen.state])}
                      />
                      <span className="truncate">{STATE_LABEL[screen.state]}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {matches.length === 0 && (
          <p className="px-3 py-6 text-center text-muted-foreground text-sm">
            {screens.length === 0 ? "No bots on this computer yet." : `No bot matches “${query}”.`}
          </p>
        )}
      </nav>

      <div className="flex flex-col gap-1 border-sidebar-border border-t p-2">
        <Button
          className="justify-start"
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
          <Button onClick={onSignOut} size="xs" type="button" variant="ghost">
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
