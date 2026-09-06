/**
 * Stale-fact / contradiction scan for vibey's group memory — adapted from
 * second-brain-agent's contradiction-scan. Pure, lexical, no model call: it
 * compares the structured roster + stored `members`/`group_facts` memory against
 * recent activity and surfaces likely-drifted facts as PROPOSALS for an admin to
 * review (it never writes anything).
 *
 * The four signals are intentionally conservative — better to miss a subtle
 * change than to spam false positives an admin has to dismiss.
 */

import { tokenize } from "./bm25.ts";
import type { BridgeMessage } from "./live-tail.ts";
import { firstName, isKnownMember } from "./roster.ts";
import type { RosterEntry } from "./roster.ts";

export interface StaleFinding {
  kind: "role_changed" | "possibly_left" | "unknown_active" | "new_recurring_topic";
  /** Member name or topic phrase the finding is about. */
  subject: string;
  /** Quoted recent/archive lines backing the finding. */
  evidence: string[];
  /** What the roster/memory says today, if anything. */
  current: string | null;
  /**
   * The line that gets written into group memory.
   *
   * **Must read as an observation, never as an instruction.** These templates
   * used to be addressed to an admin — "Verify X is still active", "Consider
   * adding Y to the members block" — and the overnight pass appended them
   * verbatim into `<group_memory>`, which is a block the model reads as
   * standing facts about the group. So @vibey's own memory filled up with
   * imperative sentences telling *someone else* to go and edit it.
   *
   * The report the admin reads renders the same text with the finding's kind,
   * confidence and evidence beside it, which is what makes it actionable — the
   * imperative mood was never carrying that weight, it was just leaking into
   * the prompt.
   */
  proposed: string;
  confidence: "low" | "med" | "high";
}

/** A recent message as the bridge returns it (`n` is the display name). */
export type RecentMessage = BridgeMessage;

export interface ArchiveHit {
  from: string;
  text: string;
  date: string;
}

export interface StaleScanArgs {
  roster: RosterEntry[];
  /** Stored `members` prose block (may be ""). */
  membersMemory: string;
  /** Stored `recurring_topics` prose block (may be ""). */
  recurringTopicsMemory: string;
  /** Live recent tail from the bridge. */
  recent: RecentMessage[];
  /** Search the deep archive (wraps the same BM25 search-chat uses). */
  archiveSearch: (query: string, sender?: string) => ArchiveHit[];
}

// Cues that a person's role/company may have changed.
const CHANGE_CUES =
  /\b(?:now at|joined|started at|moved to|new role|new job|new gig|left|leaving|departed|stepping down|no longer at|these days|now leads?|now running)\b/iu;

const CONFIDENCE_RANK: Record<StaleFinding["confidence"], number> = {
  high: 3,
  low: 1,
  med: 2,
};

const clip = (text: string, n = 200): string => {
  const t = text.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Signal 1: a roster member's name appears in recent traffic next to a change cue. */
const scanRoleChanged = (roster: RosterEntry[], recent: RecentMessage[]): StaleFinding[] => {
  const findings: StaleFinding[] = [];
  for (const member of roster) {
    const first = firstName(member.name);
    if (first.length < 3) {
      continue;
    }
    const evidence: string[] = [];
    for (const m of recent) {
      const text = m.x ?? "";
      if (!CHANGE_CUES.test(text)) {
        continue;
      }
      const lc = text.toLowerCase();
      if (lc.includes(first) || lc.includes(member.name.toLowerCase())) {
        // Skip if the member themselves is just chatting (the cue is about
        // someone else); we still surface it — an admin reads the evidence.
        evidence.push(`${m.n || m.s}: ${clip(text)}`);
      }
      if (evidence.length >= 2) {
        break;
      }
    }
    if (evidence.length > 0) {
      const current = [member.role, member.org].filter(Boolean).join(" at ") || null;
      findings.push({
        confidence: "low",
        current,
        evidence,
        kind: "role_changed",
        proposed: `${member.name} may have changed role or org since the members block was written.`,
        subject: member.name,
      });
    }
  }
  return findings;
};

/** Signal 2: someone active recently who isn't in the roster or the members block. */
const scanUnknownActive = (recent: RecentMessage[], membersLc: string): StaleFinding[] => {
  const findings: StaleFinding[] = [];
  const activity = new Map<string, { count: number; sample: string }>();
  for (const m of recent) {
    const name = (m.n || m.s || "").trim();
    if (!name) {
      continue;
    }
    const cur = activity.get(name) ?? { count: 0, sample: "" };
    cur.count += 1;
    if (!cur.sample && m.x) {
      cur.sample = `${name}: ${clip(m.x)}`;
    }
    activity.set(name, cur);
  }
  for (const [name, { count, sample }] of activity) {
    if (isKnownMember(name, membersLc)) {
      continue;
    }
    let confidence: StaleFinding["confidence"];
    if (count >= 5) {
      confidence = "high";
    } else if (count >= 2) {
      confidence = "med";
    } else {
      confidence = "low";
    }
    findings.push({
      confidence,
      current: null,
      evidence: sample ? [sample] : [],
      kind: "unknown_active",
      proposed: `${name} has been active in the group but isn't on the roster.`,
      subject: name,
    });
  }
  return findings;
};

/** Signal 3: a roster member with no recent activity AND no archive hits. */
const scanPossiblyLeft = (
  roster: RosterEntry[],
  recent: RecentMessage[],
  archiveSearch: StaleScanArgs["archiveSearch"],
): StaleFinding[] => {
  const findings: StaleFinding[] = [];
  const recentNames = new Set(
    recent.map((m) => (m.n || m.s || "").trim().toLowerCase()).filter(Boolean),
  );
  for (const member of roster) {
    const first = firstName(member.name);
    const activeRecently =
      recentNames.has(member.name.toLowerCase()) ||
      [...recentNames].some((n) => first.length >= 3 && n.includes(first));
    if (activeRecently) {
      continue;
    }
    const hits = archiveSearch(member.name);
    if (hits.length === 0) {
      findings.push({
        confidence: "low",
        current: [member.role, member.org].filter(Boolean).join(" at ") || null,
        evidence: [],
        kind: "possibly_left",
        proposed: `${member.name} has no recent messages and no archive mentions, so may no longer be active.`,
        subject: member.name,
      });
    }
  }
  return findings;
};

/**
 * How often a term must appear in a day before it counts as a theme. At ~24
 * messages a day, the original 4 surfaced ordinary English verbs ("talk",
 * "been", "running") on the first live run; 8 means the term is in roughly a
 * third of the day's traffic, which is what "recurring" should mean.
 */
const MIN_TOPIC_MENTIONS = 8;

/**
 * Terms that are frequent in this chat but are not themes. Observed on the very
 * first live run, which proposed "vibey" (members addressing the bot), "haha",
 * and "fraser" (a person, not a topic) as recurring topics.
 */
const NOT_A_TOPIC = new Set([
  "vibey",
  "vibe",
  "haha",
  "hahaha",
  "yeah",
  "yep",
  "nah",
  "thanks",
  "cheers",
  "please",
  "sorry",
  "actually",
  "probably",
  "definitely",
  "something",
  "anything",
  "everyone",
  "someone",
  "would",
  "could",
  "should",
  "think",
  "thing",
  "things",
  "really",
  "still",
  "gonna",
  "wanna",
  "https",
  "http",
]);

/** Signal 4: a high-frequency term in recent traffic that stored topics don't mention. */
const scanNewRecurringTopics = (
  recent: RecentMessage[],
  topicsLc: string,
  excluded: ReadonlySet<string>,
): StaleFinding[] => {
  const findings: StaleFinding[] = [];
  const freq = new Map<string, number>();
  for (const m of recent) {
    for (const tok of new Set(tokenize(m.x ?? ""))) {
      if (tok.length < 4) {
        continue;
      }
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }
  const candidates = [...freq.entries()]
    .filter(
      ([term, n]) =>
        n >= MIN_TOPIC_MENTIONS &&
        !topicsLc.includes(term) &&
        !NOT_A_TOPIC.has(term) &&
        // A person's name is a roster signal, not a theme.
        !excluded.has(term),
    )
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [term, n] of candidates) {
    findings.push({
      confidence: n >= 8 ? "med" : "low",
      current: null,
      // inline note moved here: appeared in recent messages
      evidence: [`"${term}" appeared in ~${n} recent messages`],
      kind: "new_recurring_topic",
      proposed: `"${term}" came up repeatedly in the group's recent conversation.`,
      subject: term,
    });
  }
  return findings;
};

export const scanForStaleFacts = (args: StaleScanArgs): StaleFinding[] => {
  const membersLc = args.membersMemory.toLowerCase();
  const topicsLc = args.recurringTopicsMemory.toLowerCase();

  // Every token of every known name: people are roster signals, not themes.
  const rosterTerms = new Set<string>();
  for (const person of args.roster) {
    for (const name of [person.name, ...(person.aliases ?? [])]) {
      for (const token of name.toLowerCase().split(/\s+/u)) {
        if (token.length >= 3) {
          rosterTerms.add(token);
        }
      }
    }
  }

  const findings: StaleFinding[] = [
    ...scanRoleChanged(args.roster, args.recent),
    ...scanUnknownActive(args.recent, membersLc),
    ...scanPossiblyLeft(args.roster, args.recent, args.archiveSearch),
    ...scanNewRecurringTopics(args.recent, topicsLc, rosterTerms),
  ];

  return findings.toSorted((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]);
};
