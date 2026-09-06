import { archiveSearch } from "./archive-search.ts";
import { bridgeConfigured, bridgeGet } from "./bridge-client.ts";
import { applyAdditions, buildConsolidation, formatWriteReport } from "./consolidation.ts";
import type { ConsolidationPlan } from "./consolidation.ts";
import type { BridgeMessage } from "./live-tail.ts";
import type { GroupMemoryCategory } from "./memory-categories.ts";
import {
  appendMemoryWrites,
  blobConfigured,
  dayKey,
  mutateJson,
  memoryKey,
  readGroupMemory,
  readMemoryWrites,
} from "./memory-store.ts";
import type { GroupMemory } from "./memory-store.ts";
import { vcmcRoster } from "./roster.ts";
import { scanForStaleFacts } from "./stale-scan.ts";
import { checkInvariants, nightlyAppliedCounts } from "./tripwires.ts";
import type { TripwireResult } from "./tripwires.ts";

/**
 * The overnight pass: read the day's messages, look for drift, and write what
 * it finds.
 *
 * It notifies nobody. Every write is tagged, recorded in the audit log, and
 * undoable with `revert-memory`, and `memory-log` answers "what have you
 * learned lately" on demand — so the accountability is queryable rather than
 * pushed. The formatted report still goes to the runtime log each night.
 *
 * Extraction is `scanForStaleFacts` unchanged — pure, already unit-tested, and
 * no model call, so the loop costs nothing per night and can't hallucinate a
 * fact. Whether four lexical signals find enough to be worth running is the open
 * question this is designed to answer cheaply before anything more expensive
 * gets built.
 */

/**
 * The bot's own display name as the bridge records it (`BOT_NAME` in
 * bridge/index.ts). Lower-cased for comparison.
 */
const BOT_DISPLAY_NAME = "vibey";

/** Which hourly tick runs the pass. UTC — Vercel Cron has no timezone. */
export const consolidationHour = (): number => {
  const raw = Number(process.env.MEMORY_CONSOLIDATION_HOUR);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 16;
};

interface ConsolidationResult {
  ran: boolean;
  reason?: string;
  applied: number;
  plan?: ConsolidationPlan;
  report?: string;
  /**
   * Invariants over the finished run. Present whenever the pass actually ran;
   * the caller decides what a violation is worth (see the schedule, which pages).
   */
  tripwires?: TripwireResult;
}

/**
 * Run one consolidation pass for a group. Returns what happened; the caller
 * owns delivery.
 */
export const runConsolidation = async ({
  groupJid,
  now = new Date(),
}: {
  groupJid: string;
  now?: Date;
}): Promise<ConsolidationResult> => {
  if (!(bridgeConfigured() && blobConfigured())) {
    return { applied: 0, ran: false, reason: "bridge or blob not configured" };
  }

  const day = dayKey(now);
  // The audit trail comes along for the ride: it is where the previous nights'
  // write counts live, and the "extractor silently stopped" tripwire needs them.
  // Three independent reads, so one round trip rather than three.
  const [memoryRead, writes, { messages = [] }] = await Promise.all([
    readGroupMemory(groupJid),
    readMemoryWrites(groupJid),
    // 24h of messages. The bridge clamps n at 2000; a busy VCMC day is ~24.
    bridgeGet<{ messages?: BridgeMessage[] }>(
      `/messages?group=${encodeURIComponent(groupJid)}&n=1500`,
    ),
  ]);
  const memory = memoryRead ?? {};
  const cutoff = Math.floor(now.getTime() / 1000) - 24 * 60 * 60;
  const recent = messages
    .filter((m) => m.t >= cutoff)
    // Drop @vibey's own messages. The bridge records them with the bot's
    // display name, so without this the scan sees the most prolific "unknown
    // active member" in the group and proposes adding the bot to its own
    // roster — which is exactly what the first live dry run did.
    .filter((m) => (m.n ?? "").trim().toLowerCase() !== BOT_DISPLAY_NAME);

  const findings = scanForStaleFacts({
    archiveSearch,
    membersMemory: memory.members ?? "",
    recent,
    recurringTopicsMemory: memory.recurring_topics ?? "",
    roster: vcmcRoster(),
  });

  // A revert files itself in the audit trail as `r_<id>`, which is the only
  // durable record that a human said no — the block itself is gone from memory
  // by then, so nothing else could tell the pass not to write it again.
  const revertedIds = new Set(
    writes.filter((w) => w.id.startsWith("r_")).map((w) => w.id.slice("r_".length)),
  );

  // `recent` is the same window the findings were scanned from, which is what
  // the provenance gate checks each proposed write against. Without it
  // buildConsolidation reports "nothing was provenance-checked" and the whole
  // fabricated-source class walks through, so this argument is load-bearing.
  const plan = buildConsolidation({
    findings,
    memory,
    messages: recent,
    revertedIds,
  });
  const applied = plan.proposals.length;
  const before = memory;
  // Starts as the memory we read: on a night with nothing to write, "after" is
  // "before", and the shape invariants still get to run over it.
  let memoryAfter: GroupMemory | null = memory;

  if (applied > 0) {
    // One atomic read-modify-write for the whole night, not one per proposal:
    // fewer round trips, and the run either lands or doesn't.
    const byCategory = new Map<GroupMemoryCategory, string[]>();
    for (const p of plan.proposals) {
      byCategory.set(p.category, [...(byCategory.get(p.category) ?? []), p.addition]);
    }

    memoryAfter = await mutateJson<GroupMemory>(memoryKey(groupJid), (current) => {
      const next = { ...current };
      for (const [category, additions] of byCategory) {
        next[category] = applyAdditions(next[category], additions);
      }
      return next;
    });

    // Audit after the write lands, one entry per proposal, each carrying the
    // prior text so a revert can restore it verbatim. One batched append, not
    // one per proposal: they all target the same blob, so appending
    // individually would fire N concurrent read-modify-writes, exhaust the
    // retry budget, and silently drop entries for exactly the writes that most
    // need a record.
    await appendMemoryWrites(
      groupJid,
      plan.proposals.map((p) => ({
        by: "overnight-pass",
        category: p.category,
        content: p.addition,
        id: p.id,
        previous: before[p.category] ?? null,
        reason: `${p.kind}: ${p.subject}`,
        source: "auto" as const,
        t: Math.floor(now.getTime() / 1000),
      })),
    );
  }

  return {
    applied,
    plan,
    ran: true,
    report: formatWriteReport(plan, { applied: applied > 0, day }),
    // Checked on every run, including the ones that wrote nothing — a run of
    // empty nights is itself one of the invariants.
    tripwires: checkInvariants({
      applied,
      history: nightlyAppliedCounts(writes, { now }),
      memoryAfter,
      memoryBefore: before,
      plan,
      recentMessages: recent,
    }),
  };
};
