import { defineTool } from "eve/tools";
import { z } from "zod";

import { buildBm25 } from "../vibey/bm25.ts";
import { archiveAvailable, getArchiveIndex } from "../vibey/chat-archive.ts";
import { fetchLiveTail, freshTail, mergeRanked } from "../vibey/live-tail.ts";
import { readEpisodes } from "../vibey/memory-store.ts";
import { formatBakedReactions } from "../vibey/reactions.ts";
import { groupJidFromAuth } from "../vibey/session.ts";

/**
 * BM25 search over the VCMC group chat. The deep history ships embedded
 * (gzipped+base64), decoded and indexed once on first use. On top of that, when
 * we're in the WhatsApp group, we also pull the bridge's live tail (anything
 * said since the embedded archive's cutoff) and merge it in, so a recall ask
 * about something said recently isn't a miss.
 *
 * Returns matches ranked by relevance with provenance (date + sender) so the
 * agent can ground its answer and cite who said what. When the live tail is
 * present, scores are min-max normalised to ~0–1 across both corpora (raw BM25
 * scores aren't comparable across two indexes), with a small recency nudge; with
 * no bridge / off-group the result is the archive-only ranking, unchanged.
 */

// The deep-archive index is shared with audit-memory via chat-archive.js so the
// ~9k-message index isn't built or held twice. The live-tail index below is
// per-turn and stays local.
const loadArchiveIndex = () => {
  const { messages, index } = getArchiveIndex();
  return { index, msgs: messages };
};

const trunc = (x: string) => (x.length > 500 ? `${x.slice(0, 500)}…` : x);
const round = (s: number) => Math.round(s * 100) / 100;

/**
 * Compact emoji-reaction summary for a result, e.g. "❤️×3 😂×1". Only archive
 * messages carry `r` (baked from WhatsApp Web's reaction history); live-tail
 * rows don't, so this is omitted there. Lets the agent answer "did this land /
 * what got a reaction" straight from a search hit.
 */
const fmtReactions = (r?: { e: string; n: number }[]): string | undefined =>
  r?.length ? formatBakedReactions(r) : undefined;

/**
 * Absolute BM25 floor for a recap hit. The recap corpus is tiny (~one doc per
 * day) and each doc is long, so *something* always ranks top for any query —
 * relative ranking is meaningless here and only an absolute bar filters noise.
 * Empirical: a single common-term match lands ~0.5-2, a real multi-term match
 * well above 3.
 */
const RECAP_MIN_SCORE = 3;
const MAX_RECAPS = 3;

/**
 * Search @vibey's own daily recaps. Returns [] on any failure — a recap miss
 * must never cost the caller their chat results.
 */
const searchRecaps = async (
  groupJid: string,
  query: string,
): Promise<{ day: string; score: number; source: string; text: string }[]> => {
  try {
    const episodes = await readEpisodes(groupJid);
    if (episodes.length === 0) {
      return [];
    }
    const index = buildBm25(episodes.map((e) => e.text));
    return index
      .search(query, MAX_RECAPS)
      .filter((r) => r.score >= RECAP_MIN_SCORE)
      .map((r) => ({
        day: episodes[r.index].day,
        score: round(r.score),
        source:
          "@vibey's own daily recap — a summary, not a member quote; don't attribute it to anyone",
        text: trunc(episodes[r.index].text),
      }));
  } catch {
    return [];
  }
};

export default defineTool({
  description:
    "Search the VCMC WhatsApp group chat history (deep archive from Mar 2025 plus recent live messages) with BM25 relevance ranking. Use it to answer what the group discussed, who said what, when a topic came up, links/tools shared, or the prevailing take on a model or tool. Results are ranked by relevance (not recency) with date + sender for citation; `matched` is the TOTAL count of messages matching the query (after any sender filter), so use it for 'how many times' asks even when `results` is capped. If the first query is too narrow, try again with broader or alternative terms. A `recaps` field may also appear: those are @vibey's own past daily summaries, useful for 'what happened around then' — never quote them as something a member said.",
  async execute(input, ctx) {
    const limit = input.limit ?? 15;
    const senderQ = input.sender?.toLowerCase();

    // No archive on this computer's volume: not this community. Say so rather
    // than search an empty index and report that nobody ever said anything.
    if (!archiveAvailable()) {
      return { available: false, note: "This computer has no chat archive to search." };
    }

    const { msgs: aMsgs, index: aIndex } = loadArchiveIndex();

    // Live tail: archive-shaped rows not already baked into the archive.
    const jid = groupJidFromAuth(ctx.session.auth);
    const fresh = freshTail(aMsgs, await fetchLiveTail(jid));

    // Rank the whole corpus, not just the top page: bm25 scores every doc
    // sharing a query term before slicing anyway, so the full list is free,
    // `matched` can be the true total (a count ask needs the total, not the
    // page size), and a sender filter can never run out of candidates.
    const collect = (hits: { m: (typeof aMsgs)[number]; score: number }[]) => {
      const results = [];
      let matched = 0;
      for (const { m, score } of hits) {
        if (senderQ && !m.s.toLowerCase().includes(senderQ)) {
          continue;
        }
        matched += 1;
        if (results.length < limit) {
          results.push({
            date: m.t,
            from: m.s,
            reactions: fmtReactions(m.r),
            score: round(score),
            text: trunc(m.x),
          });
        }
      }
      return { matched, results };
    };

    // @vibey's own past daily recaps, searched separately and returned in their
    // own field rather than merged into the message ranking. Two reasons:
    // mergeRanked normalises each corpus against its own top hit, so a ~60-doc
    // recap index would surface a ~1.0 "best match" for literally every query;
    // and a recap is @vibey's summary, not something a member said, so keeping
    // it out of `results` makes it impossible to cite as a quote by accident.
    const recaps = jid ? await searchRecaps(jid, input.query) : [];

    // Archive-only fast path: no bridge / off-group / nothing new → raw BM25
    // scores, same ranking as before.
    if (fresh.length === 0) {
      return {
        ...collect(
          aIndex
            .search(input.query, aMsgs.length)
            .map((r) => ({ m: aMsgs[r.index], score: r.score })),
        ),
        ...(recaps.length > 0 ? { recaps } : {}),
      };
    }

    // Merge archive + fresh live, each ranked by its own index (scores aren't
    // comparable raw, so mergeRanked normalises per-corpus and nudges recency).
    const aRanked = aIndex
      .search(input.query, aMsgs.length)
      .map((r) => ({ m: aMsgs[r.index], score: r.score }));
    const lIndex = buildBm25(fresh.map((m) => `${m.s}: ${m.x}`));
    const lRanked = lIndex
      .search(input.query, fresh.length)
      .map((r) => ({ m: fresh[r.index], score: r.score }));
    return {
      ...collect(mergeRanked(aRanked, lRanked, aRanked.length + lRanked.length)),
      ...(recaps.length > 0 ? { recaps } : {}),
    };
  },
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Max messages to return (default 15). Caps `results` only; `matched` always reports the total.",
      ),
    query: z
      .string()
      .describe(
        "Search terms. Ranked by BM25 relevance, so include the meaningful keywords; you don't need exact phrasing. Try synonyms or a broader query if the first search is thin.",
      ),
    sender: z
      .string()
      .optional()
      .describe("Optional: restrict to a person (substring match on name, e.g. 'Marcus')."),
  }),
});
