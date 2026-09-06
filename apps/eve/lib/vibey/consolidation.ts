import { createHash } from "node:crypto";

import type { BridgeMessage } from "./live-tail.ts";
import type { GroupMemoryCategory } from "./memory-categories.ts";
import type { GroupMemory } from "./memory-store.ts";
import { screenWrite } from "./provenance.ts";
import type { StaleFinding } from "./stale-scan.ts";

/**
 * Turns the drift findings from `scanForStaleFacts` into memory writes the
 * overnight pass can apply on its own.
 *
 * DELIBERATELY DOES NOT IMPORT `#lib/memory-health.js`. `memoryHealth` scores
 * memory on category coverage and freshness; a loop that could both read that
 * score and write memory would learn the cheapest way to raise it is to stuff
 * every category with something, anything. Keeping the evaluator outside the
 * loop is the whole reason the score is not available here, and
 * `consolidation.test.ts` asserts the import is absent so the separation can't
 * quietly erode. (Weng, "Harness Engineering for Self-Improvement": the
 * evaluator and permission controls belong outside the loop, or the agent
 * optimises the referee instead of the game.)
 *
 * Three properties make an autonomous write safe to leave running unattended:
 *   - append-only, so a write can never destroy prose a human wrote;
 *   - bounded per run, so a bad night is small;
 *   - tagged, so every write is individually revertable and visibly non-human.
 */

/** Marks a block as machine-written. Also the handle a revert removes. */
export const AUTO_TAG = (id: string): string => `⟨auto:${id}⟩`;

/** Ceiling on what one run may add to one category. A bad night stays small. */
export const MAX_AUTO_CHARS_PER_CATEGORY = 400;

/** Which category each drift signal belongs in. */
const CATEGORY_FOR: Record<StaleFinding["kind"], GroupMemoryCategory> = {
  new_recurring_topic: "recurring_topics",
  possibly_left: "members",
  role_changed: "members",
  unknown_active: "members",
};

export interface ConsolidationProposal {
  id: string;
  category: GroupMemoryCategory;
  /** The line appended to the category, tag included. */
  addition: string;
  /** The same text without the tag, for the human-facing report. */
  proposed: string;
  subject: string;
  kind: StaleFinding["kind"];
  evidence: string[];
  confidence: StaleFinding["confidence"];
}

export interface SkippedProposal {
  subject: string;
  kind: StaleFinding["kind"];
  reason: string;
}

export interface ConsolidationPlan {
  proposals: ConsolidationProposal[];
  /** Reported in the morning DM so a silent drop is impossible. */
  skipped: SkippedProposal[];
  /**
   * Whether the provenance gate actually ran, i.e. whether the caller supplied
   * the message window. Optional so existing `ConsolidationPlan` literals stay
   * valid; `buildConsolidation` always sets it, and `formatWriteReport` says so
   * out loud when it is false. A run that skipped the primary screen must never
   * read like a clean one.
   */
  provenanceChecked?: boolean;
}

/**
 * Kinds whose evidence is structurally empty, so the provenance gate cannot
 * apply. Exactly one: `possibly_left` is an *absence* claim ("no recent
 * messages or archive mentions"), and no message can source an absence.
 *
 * Safe to exempt because it carries no attacker-controlled text: its proposed
 * line is a template over a roster name, and the roster is a code constant, not
 * something a group member can write into. It is also falsified after the fact
 * — `tripwires.checkSourcing` fails the run if the "inactive" member did post
 * in the window — so the claim is still checked, just not by this gate.
 */
const SOURCELESS_KINDS: ReadonlySet<StaleFinding["kind"]> = new Set(["possibly_left"]);

/**
 * Stable per (kind, subject), for the life of the finding.
 *
 * Vercel Cron is best-effort and may fire a schedule more than once, so a
 * replay has to produce the same ids — otherwise the same drift is appended
 * twice under two handles and the admin has to revert both.
 *
 * The day used to be part of this, which made the id stable within a night and
 * *unstable* across nights — so `alreadyApplied` could never recognise a
 * finding it had already written. Standing conditions never resolve on their
 * own ("Jackie hasn't posted" stays true forever), so the pass re-appended the
 * same two lines every night: by 2026-08-09 the members block held five copies
 * each of two findings, all of it going into the system prompt on every reply,
 * and the growth is what pushed the blob past the 1KB mark that detonated the
 * weak-etag bug in `memory-store`. Dropping the day satisfies the replay
 * requirement strictly better — the id is now stable across every run, not
 * just the ones sharing a date.
 */
export const proposalId = (kind: string, subject: string): string =>
  createHash("sha256").update(`${kind}#${subject.toLowerCase()}`).digest("base64url").slice(0, 6);

/** Already written by a previous run? Tags in the prose are the record. */
const alreadyApplied = (memory: GroupMemory, id: string): boolean =>
  Object.values(memory).some((prose) => prose?.includes(AUTO_TAG(id)));

/**
 * Build the night's writes. Pure: no clock, no network, no model — the caller
 * supplies `day` and the findings, which makes the whole thing trivially
 * testable and keeps replays deterministic.
 */
export const buildConsolidation = ({
  findings,
  memory,
  messages,
  revertedIds,
  maxCharsPerCategory = MAX_AUTO_CHARS_PER_CATEGORY,
}: {
  findings: StaleFinding[];
  memory: GroupMemory;
  /**
   * Ids an admin has already reverted. A revert strips the block from memory,
   * so `alreadyApplied` stops recognising it and the pass would write the exact
   * line a human just removed — every night, for as long as the condition
   * holds. "No" has to be durable, or the human control isn't one.
   */
  revertedIds?: ReadonlySet<string>;
  /**
   * The window the findings were scanned from — the same array `runConsolidation`
   * passes to `scanForStaleFacts`. Supplying it turns on the provenance gate:
   * a finding may only be written if its evidence quotes a message that is
   * actually in here. Omitting it skips that gate, which is reported rather
   * than silent.
   */
  messages?: readonly BridgeMessage[];
  maxCharsPerCategory?: number;
}): ConsolidationPlan => {
  const proposals: ConsolidationProposal[] = [];
  const skipped: SkippedProposal[] = [];
  const usedPerCategory = new Map<GroupMemoryCategory, number>();

  for (const finding of findings) {
    const category = CATEGORY_FOR[finding.kind];
    const id = proposalId(finding.kind, finding.subject);

    if (alreadyApplied(memory, id)) {
      continue;
    }

    if (revertedIds?.has(id)) {
      skipped.push({
        kind: finding.kind,
        reason: `previously reverted (${id})`,
        subject: finding.subject,
      });
      continue;
    }

    // Two layers. Provenance first: the fact must quote a message that was
    // really in the window, which is what catches the payloads that read as
    // ordinary description. Then the regex over the model-facing text AND the
    // member-authored evidence, which is the half an attacker controls.
    const screen = screenWrite({
      evidence: finding.evidence,
      messages: SOURCELESS_KINDS.has(finding.kind) ? undefined : messages,
      proposed: finding.proposed,
    });
    if (!screen.ok) {
      skipped.push({
        kind: finding.kind,
        reason: `${screen.layer}: ${screen.reason}`,
        subject: finding.subject,
      });
      continue;
    }

    const proposed = finding.proposed.trim();
    const addition = `${AUTO_TAG(id)} ${proposed}`;
    const used = usedPerCategory.get(category) ?? 0;
    if (used + addition.length > maxCharsPerCategory) {
      skipped.push({
        kind: finding.kind,
        reason: `would exceed the ${maxCharsPerCategory}-char nightly budget for ${category}`,
        subject: finding.subject,
      });
      continue;
    }

    usedPerCategory.set(category, used + addition.length);
    proposals.push({
      addition,
      category,
      confidence: finding.confidence,
      evidence: finding.evidence,
      id,
      kind: finding.kind,
      proposed,
      subject: finding.subject,
    });
  }

  return { proposals, provenanceChecked: messages !== undefined, skipped };
};

/**
 * Append the night's additions to a category's existing prose. Append-only: the
 * prior text is returned verbatim with the new block after it, so an autonomous
 * write can add to what a human wrote but never edit or remove it.
 */
export const applyAdditions = (
  current: string | undefined,
  additions: readonly string[],
): string => {
  const base = (current ?? "").trimEnd();
  const block = additions.join("\n");
  return base ? `${base}\n${block}` : block;
};

/**
 * Remove one tagged block, for revert. Drops only the line carrying the tag, so
 * surrounding human prose and other automatic blocks are untouched.
 */
export const stripAutoBlock = (current: string, id: string): string => {
  const tag = AUTO_TAG(id);
  return current
    .split("\n")
    .filter((line) => !line.includes(tag))
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
};

/** The morning DM. Deterministic text — no model call needed to format it. */
export const formatWriteReport = (
  plan: ConsolidationPlan,
  { day, applied }: { day: string; applied: boolean },
): string => {
  const lines: string[] = [
    applied
      ? `Overnight memory update (${day})`
      : `Overnight memory — dry run (${day}), nothing written`,
  ];

  // Loud, and above the fold. Without the message window the provenance gate
  // does not run, and the pass falls back to the lexical screen alone — which
  // is measured at 80% miss on the non-imperative families. A run in that state
  // must not read like a normal one.
  if (plan.provenanceChecked !== true) {
    lines.push("", "WARNING: no message window supplied, so nothing was provenance-checked.");
  }

  if (plan.proposals.length === 0 && plan.skipped.length === 0) {
    lines.push("", "Nothing drifted. No changes.");
    return lines.join("\n");
  }

  if (plan.proposals.length > 0) {
    lines.push("");
    for (const p of plan.proposals) {
      lines.push(`${p.id}  [${p.category}] ${p.subject} — ${p.confidence}`, `  ${p.proposed}`);
      if (p.evidence[0]) {
        lines.push(`  why: ${p.evidence[0]}`);
      }
    }
    lines.push("", "Undo any of these with: @vibey revert memory <id>");
  }

  if (plan.skipped.length > 0) {
    lines.push("", "Skipped:");
    for (const s of plan.skipped) {
      lines.push(`  ${s.subject} (${s.kind}) — ${s.reason}`);
    }
  }

  return lines.join("\n");
};
