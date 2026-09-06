/**
 * Mechanical prompt-injection screen for anything about to be written into
 * memory.
 *
 * Memory renders inside the system prompt. Once the overnight pass writes there
 * without a human in the loop, any member can try to launder an instruction
 * into it: say something imperative in the group, wait for the loop to
 * consolidate it, and it lands in the most privileged position in the prompt.
 *
 * This is a regex on the write path, not a line in the prompt, on purpose. The
 * PiSAs work (arXiv:2607.05318) measured prompt-level mitigations at 28-29%
 * effective on memory surfaces versus ~50% on communication channels, and found
 * that strict rule specification beat vague guidance with no task-completion
 * cost. So: refuse the write, don't ask the model to be careful.
 *
 * It is one of three layers, none of which is sufficient alone: the
 * `<group_memory>` fence marks the content as data, `neutraliseFence` stops the
 * fence being closed early, and this stops the content being written at all.
 */

/**
 * Phrases that only appear when text is trying to steer the agent rather than
 * describe the group. Deliberately narrow: this rejects writes, so a false
 * positive costs a memory the group wanted. Anything matching gets refused and
 * reported, never silently dropped.
 */
const DIRECTIVE_PATTERNS: RegExp[] = [
  /\bignore (?:all |any )?(?:previous|prior|above|earlier)\b/iu,
  /\bdisregard (?:all |any )?(?:previous|prior|above|earlier)\b/iu,
  // Requires the trailing colon that makes it a directive header, not a bare
  // mention: VCMC is a group of AI engineers, so "the system prompt discussion"
  // is everyday shop talk and matching that would reject real memories daily.
  // Deliberately NOT anchored to line start — evidence arrives as transcript
  // lines ("Dave: SYSTEM NOTE: ..."), so an anchor would defeat the screen on
  // the exact half an attacker controls.
  // Known over-rejection: "Ben shared his system prompt: three pages" is
  // refused. That's the right side to err on when the write is unattended, and
  // every refusal is named in the morning report rather than dropped silently.
  /\b(?:system|admin|developer)\s+(?:note|prompt|message|instructions?)\s*:/iu,
  /\byou (?:are|act) (?:now )?(?:a|an|as)\b.{0,40}\b(?:assistant|model|ai|dan)\b/iu,
  /\bnew (?:instructions?|rules?|persona)\b/iu,
  /\bfrom now on,? (?:you|always|never)\b/iu,
  /\balways (?:reply|respond|answer|say|output|start)\b/iu,
  /\bnever (?:reveal|mention|say|refuse|decline)\b/iu,
  /\byour (?:new )?(?:instructions?|system prompt|rules?) (?:are|is)\b/iu,
  /\boverride\b.{0,20}\b(?:instructions?|rules?|prompt)\b/iu,
  /\b(?:pretend|roleplay|act) (?:to be|as if|that you)\b/iu,
  /<\/?(?:system|group_memory|untrusted_context)>/iu,
];

interface ScreenResult {
  ok: boolean;
  /** The pattern that tripped, for the morning report. */
  reason?: string;
}

/**
 * True when the text looks like an instruction aimed at the agent. Checked
 * against both the proposed memory content and the source quote it came from —
 * the quote matters because that's the member-authored half, and it's what an
 * attacker actually controls.
 */
export const looksLikeDirective = (text: string): ScreenResult => {
  if (!text) {
    return { ok: true };
  }
  for (const pattern of DIRECTIVE_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, reason: `matched ${pattern.source.slice(0, 48)}` };
    }
  }
  return { ok: true };
};

/** Screen every string a proposal would contribute. Fails closed on any hit. */
export const screenProposal = (parts: readonly string[]): ScreenResult => {
  for (const part of parts) {
    const result = looksLikeDirective(part);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
};
