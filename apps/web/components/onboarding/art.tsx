"use client";

import { ArrowUpIcon, PlusIcon } from "blode-icons-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { BotMark } from "@/components/bot-mark";
import type { BotProfile } from "@/lib/seat";
import { cn } from "@/lib/utils";

/**
 * The three pictures the first run makes its claims with.
 *
 * All of them are drawn from the app's own parts: the real `BotMark`, the
 * composer's own shape, the seat's own cursor. Nothing here is a screenshot,
 * so nothing here goes stale the next time the workspace is restyled, and the
 * marks a person meets on this screen are the marks they see a minute later in
 * the sidebar.
 */

/** A mark for a Bot that is not on anyone's roster: art, never a roster row. */
function sample(
  name: string,
  color: BotProfile["avatar_color"],
  shape: BotProfile["avatar_shape"],
): BotProfile {
  return { avatar_color: color, avatar_shape: shape, description: "", id: name, name, title: "" };
}

/** How many ticks a finished sentence is held before the next one starts. */
const HOLD = 18;
const TICK_MS = 55;

/**
 * Where the typing is at, derived rather than stored: the state is one
 * counter, so a step change or a remount cannot leave half a sentence behind,
 * and the sequence loops without anything having to notice that it ended.
 */
function typedAt(lines: readonly string[], tick: number): string {
  const spans = lines.map((line) => line.length + HOLD);
  const total = spans.reduce((sum, span) => sum + span, 0);
  let at = total > 0 ? tick % total : 0;
  for (const [index, span] of spans.entries()) {
    if (at < span) {
      return lines[index]?.slice(0, at) ?? "";
    }
    at -= span;
  }
  return "";
}

/** The house `prefers-reduced-motion` read: an SSR pass is always "no". */
function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The composer typing itself out, or the finished sentence for anyone who
 *  has asked for less movement. */
function useTyped(lines: readonly string[]): string {
  const still = useReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (still) {
      return;
    }
    const id = window.setInterval(() => setTick((previous) => previous + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, [still]);

  return still ? (lines[0] ?? "") : typedAt(lines, tick);
}

/** How much of the sentence the pill can hold before it scrolls. */
const VISIBLE = 34;

const ASKS = [
  "Book the flights and put them in my calendar",
  "Chase the two invoices that are still unpaid",
  "Check the deploy and tell me if it broke",
] as const;

/** Step one: a Bot, and the one field you reach it through. */
export function MeetArt(): React.ReactElement {
  const typed = useTyped(ASKS);
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-14">
      <BotMark
        botId="main"
        className="size-28 shadow-[0_24px_60px_-24px_rgba(255,255,255,0.45)] sm:size-32"
        profile={sample("main", "#0091ff", "circle")}
      />
      {/* The composer, drawn rather than mounted: it types on its own and
          nothing here is focusable, so a tap goes to Next like every other
          tap on this screen. */}
      <div
        aria-hidden
        className="flex w-full items-center gap-3 rounded-full border border-white/15 py-2 pr-2 pl-2"
      >
        <span className="flex size-9 items-center justify-center rounded-full bg-white/10 text-white/60">
          <PlusIcon />
        </span>
        {/* The tail rather than the head, like a field that has been typed
            past its width: the caret is the part that has to stay on screen. */}
        <span className="min-w-0 flex-1 truncate text-left text-[0.95rem] text-white/80">
          {typed.slice(-VISIBLE)}
          <span className="animate-caret-blink ml-px inline-block h-4 w-px translate-y-0.5 bg-white/80" />
        </span>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-black">
          <ArrowUpIcon />
        </span>
      </div>
    </div>
  );
}

/** A window on the desktop: chrome, a sidebar and some lines of nothing. */
function Window({ className }: { className: string }): React.ReactElement {
  return (
    <div className={cn("absolute overflow-hidden rounded-lg bg-white shadow-2xl", className)}>
      <div className="flex items-center gap-1 border-black/5 border-b bg-black/[0.03] px-2 py-1.5">
        <span className="size-1.5 rounded-full bg-[#ff5f57]" />
        <span className="size-1.5 rounded-full bg-[#febc2e]" />
        <span className="size-1.5 rounded-full bg-[#28c840]" />
      </div>
      <div className="flex h-full gap-2 p-2">
        <div className="w-1/4 space-y-1.5">
          <span className="block h-2 rounded-sm bg-black/10" />
          <span className="block h-2 w-3/4 rounded-sm bg-black/[0.07]" />
        </div>
        <div className="flex-1 space-y-1.5">
          <span className="block h-2 w-5/6 rounded-sm bg-black/10" />
          <span className="block h-2 w-2/3 rounded-sm bg-black/[0.07]" />
          <span className="block h-8 rounded-sm bg-black/[0.05]" />
        </div>
      </div>
    </div>
  );
}

/** The seat's pointer, drawn here rather than imported: it has to read as a
 *  mouse arrow at 20px on a white window, and it is the one glyph on this
 *  screen that carries the claim. */
function Pointer(): React.ReactElement {
  return (
    <svg className="size-5 text-[#00c972] drop-shadow" fill="currentColor" viewBox="0 0 24 24">
      <title>Pointer</title>
      <path d="m4 4 7.07 17 2.51-7.39L21 11.06z" />
    </svg>
  );
}

/** Step two: its own screen, with something on it that is not you. */
export function ComputerArt(): React.ReactElement {
  return (
    <div
      aria-hidden
      className="relative aspect-[4/3] w-full max-w-sm rounded-xl bg-gradient-to-br from-white/30 to-white/10 p-4 shadow-[0_40px_80px_-40px_rgba(0,0,0,0.9)]"
    >
      <Window className="top-6 left-5 h-1/2 w-3/5" />
      <Window className="top-1/3 left-1/4 h-1/2 w-2/3" />
      {/* The pointer is a Bot's, which is the whole claim of this step: the
          screen is being driven, and not by the person holding the phone. */}
      <span className="absolute top-[52%] left-[26%] flex items-center">
        <Pointer />
        <BotMark
          botId="designer"
          className="-ml-1 size-9"
          profile={sample("designer", "#00c972", "circle")}
        />
      </span>
    </div>
  );
}

/**
 * Three of the routines this computer actually runs (`docs/BOTS.md`), because
 * an invented example on the one screen that explains routines is the sort of
 * thing a person finds out about a week later.
 */
const ROUTINES = [
  { color: "#e5484d", label: "Morning brief", shape: "circle" },
  { color: "#00c972", label: "Production smoke", shape: "squircle" },
  { color: "#f76b15", label: "Weekly funnel scan", shape: "blob" },
] as const;

/** Step three: work that arrives without you asking for it that morning. */
export function HandoffArt(): React.ReactElement {
  return (
    <ul className="grid w-full max-w-sm grid-cols-2 items-center gap-y-8 pb-4">
      {ROUTINES.map((routine, index) => (
        <li
          className={cn("flex flex-col items-center gap-2", index === 0 && "col-span-2")}
          key={routine.label}
        >
          <BotMark
            botId={routine.label}
            className="size-16"
            profile={sample(routine.label, routine.color, routine.shape)}
          />
          <span className="rounded-full bg-white/10 px-3 py-1 text-sm text-white/85">
            {routine.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
