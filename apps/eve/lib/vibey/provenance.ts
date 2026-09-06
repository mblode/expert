import { screenProposal } from "./injection-screen.ts";
import type { BridgeMessage } from "./live-tail.ts";

/**
 * Provenance gate for the overnight memory write.
 *
 * The rule: the pass may only write a fact that cites a message present
 * verbatim in the window it actually fetched. A fact nobody can be shown to
 * have said is a fabrication, whatever it sounds like.
 *
 * This replaces `looksLikeDirective` as the *primary* screen. The measured
 * reason is in `injection-screen.mpsr.test.ts`: over the 2026 memory-poisoning
 * families, a lexical screen for imperative phrasing let 52 of 65 payloads
 * through while refusing 5 of 16 legitimate writes. It is looking for the wrong
 * property. MINJA, AgentPoison demonstrations, delayed conditionals and
 * zombie-agent re-write clauses all read as neutral description; none of them
 * contains a verb aimed at the agent. What they do share is that no member ever
 * said them — the record is authored by the model. Provenance is structural, so
 * it does not care how the payload reads.
 *
 * `looksLikeDirective` stays as a second, narrower layer (`screenWrite` runs
 * both). It is cheap, it is the only thing that catches the imperative family
 * once an attacker *has* posted the line, and it is the one family where the
 * screen is at 0% miss. Provenance primary, regex defence in depth.
 *
 * WHAT THIS DOES NOT SOLVE, plainly:
 *
 *   1. An attacker who posts the payload in the group has a real source. The
 *      quote is genuine, provenance passes, and only the regex is left — which
 *      means the non-imperative families still get through. Provenance makes
 *      that attack attributable and public (said in front of ~100 people, under
 *      a name, in a message anyone can scroll back to) rather than impossible.
 *      It converts an anonymous remote write into a social act. That is a much
 *      better problem, not a solved one.
 *   2. It grounds the *citation*, not the *claim*. Nothing here checks that the
 *      written fact follows from the quoted message. Today that gap is closed
 *      by construction — `stale-scan` emits template text with only a roster
 *      name or a token interpolated — but the moment the loop writes free
 *      prose, a model could cite a real, trivial message and attach anything.
 *      The fix for that is constraining the written shape, not a longer regex.
 *
 * Deliberate duplication note: `tripwires.checkSourcing` applies the same rule
 * *after* the write as an alarm. This module is the same rule *before* it, as a
 * gate. They are kept byte-compatible in behaviour on purpose — a write that
 * passes the gate must not page someone at 3am — and `tripwires` should
 * eventually import `evidenceVerdict` from here rather than carry its own copy.
 */

/** Collapse whitespace and case so a quote can be compared to its source. */
const norm = (text: string): string => text.replaceAll(/\s+/gu, " ").trim().toLowerCase();

/**
 * `stale-scan`'s `clip` marks truncation with U+2026 at 200 chars, so a long
 * message arrives as a prefix. Dropping the ellipsis before matching is the
 * only normalisation applied to the quote beyond whitespace and case — anything
 * looser (stripping punctuation, fuzzy distance) would let a near-miss pass as
 * a real message, which is exactly the property being bought here.
 */
const unclip = (quote: string): string => quote.replace(/…$/u, "").trim();

const clip = (text: string, n = 120): string => (text.length > n ? `${text.slice(0, n)}…` : text);

/**
 * The one evidence shape that is a count rather than a quote, emitted by
 * `scanNewRecurringTopics`.
 */
const FREQUENCY_EVIDENCE = /^"(?<term>[^"]+)" appeared in ~\d+ recent messages$/u;

type EvidenceVerdict = "misattributed" | "sourced" | "unsourced";

/**
 * Is one evidence line traceable to a message in the window?
 *
 * Evidence arrives as `"<sender>: <possibly truncated text>"` (see the three
 * `scan*` functions in `stale-scan.ts`), so the composed line is split and the
 * *body* is compared against the message body — comparing the whole line would
 * never match, because no message contains its own sender prefix.
 *
 * Both halves are checked: the quote has to appear inside a real message, and
 * that message has to be from the named sender. A fact attributed to the wrong
 * person is as wrong as one nobody said, and it is reported separately so the
 * morning report can say which of the two happened.
 *
 * Every `": "` position is tried as the split rather than just the first,
 * because both halves can contain one: a display name like `Dave :: work`, or
 * an ordinary message opening `re: the offsite`. Trying them all cannot loosen
 * the check — the quote still has to appear verbatim in a real message under a
 * matching sender — it only stops a punctuation quirk from refusing a real,
 * correctly sourced fact.
 */
export const evidenceVerdict = (
  evidence: string,
  messages: readonly BridgeMessage[],
): EvidenceVerdict => {
  // `new_recurring_topic` cites a frequency, not a person. Presence of the term
  // is what is checkable; re-deriving the count would mean copying the
  // scanner's tokeniser, and a check that shares the code it checks passes for
  // the same reason the code fails.
  const term = FREQUENCY_EVIDENCE.exec(evidence)?.groups?.term;
  if (term) {
    return messages.some((m) => norm(m.x ?? "").includes(norm(term))) ? "sourced" : "unsourced";
  }

  let sawQuote = false;
  for (let i = evidence.indexOf(": "); i > 0; i = evidence.indexOf(": ", i + 1)) {
    const sender = norm(evidence.slice(0, i));
    const quote = unclip(norm(evidence.slice(i + 2)));
    // An empty quote would make `includes` trivially true — that is the one way
    // this check could pass on nothing, so it is excluded explicitly.
    if (!quote) {
      continue;
    }
    for (const m of messages) {
      if (!norm(m.x ?? "").includes(quote)) {
        continue;
      }
      sawQuote = true;
      if (norm(m.n || m.s || "") === sender) {
        return "sourced";
      }
    }
  }
  return sawQuote ? "misattributed" : "unsourced";
};

interface ProvenanceInput {
  /** The text about to be written to a memory category. */
  proposed: string;
  /** The composed evidence lines the write claims to come from. */
  evidence: readonly string[];
  /**
   * The window the findings were drawn from. Passed in rather than fetched:
   * the check has to run against the messages this run actually saw, and a
   * module-level cache would let a later run vouch for an earlier one's quote.
   */
  messages: readonly BridgeMessage[];
}

interface ProvenanceResult {
  ok: boolean;
  /** Why the write was refused, for the morning report. */
  reason?: string;
}

/**
 * Does this proposal cite something real? One sourced evidence line is enough —
 * the scan emits at most two and they back the same claim, so requiring all of
 * them would refuse a write over a second quote that happened to be truncated
 * mid-emoji.
 */
export const checkProvenance = ({
  proposed,
  evidence,
  messages,
}: ProvenanceInput): ProvenanceResult => {
  const what = clip(proposed.trim() || "(no text)");

  // Explicit, not a fall-through: an empty `evidence` array means the write
  // cites nothing at all, which is the strongest form of the thing this module
  // refuses. `possibly_left` is structurally in this position and is exempted
  // by name at the call site, where the finding's kind is known.
  if (evidence.length === 0) {
    return { ok: false, reason: `no evidence cited for "${what}"` };
  }
  if (messages.length === 0) {
    return {
      ok: false,
      reason: `no message window to check "${what}" against`,
    };
  }

  let sawMisattribution = false;
  for (const line of evidence) {
    const verdict = evidenceVerdict(line, messages);
    if (verdict === "sourced") {
      return { ok: true };
    }
    if (verdict === "misattributed") {
      sawMisattribution = true;
    }
  }

  return {
    ok: false,
    reason: sawMisattribution
      ? `evidence for "${what}" is attributed to someone who did not send it`
      : `no evidence for "${what}" appears in the fetched window`,
  };
};

/** Which layer refused, so the morning report names the mechanism. */
type ScreenLayer = "injection screen" | "provenance";

interface WriteScreenResult {
  ok: boolean;
  layer?: ScreenLayer;
  reason?: string;
}

/**
 * The full write gate, in the order the layers are meant to run: provenance
 * first because it is the one that generalises, then the regex over both the
 * model-facing text and the member-authored evidence.
 *
 * The regex still screens the evidence, not just the proposal. Provenance
 * establishes that a member really said the line; it says nothing about whether
 * quoting it into the system prompt is safe. Three of the thirteen imperative
 * payloads carry the directive *only* in the quote (the summary half is clean),
 * so narrowing the regex to the machine-authored half would reopen the one
 * family it currently catches at 100%.
 *
 * `messages` is optional and its absence skips provenance entirely. That is a
 * caller-side migration seam, not a policy: a run with no window supplied is
 * reported as unchecked (see `formatWriteReport`) rather than passing quietly.
 */
export const screenWrite = ({
  proposed,
  evidence,
  messages,
}: {
  proposed: string;
  evidence: readonly string[];
  messages?: readonly BridgeMessage[];
}): WriteScreenResult => {
  if (messages) {
    const sourced = checkProvenance({ evidence, messages, proposed });
    if (!sourced.ok) {
      return { layer: "provenance", ok: false, reason: sourced.reason };
    }
  }

  const screened = screenProposal([proposed, ...evidence]);
  if (!screened.ok) {
    return { layer: "injection screen", ok: false, reason: screened.reason };
  }

  return { ok: true };
};
