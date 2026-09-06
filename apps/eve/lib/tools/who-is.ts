import { defineTool } from "eve/tools";
import { z } from "zod";

import { memberNames, people } from "../vibey/data/people.ts";
import type { PersonProfile } from "../vibey/data/people.ts";
import { tokenize } from "../vibey/bm25.ts";
import { loadArchive } from "../vibey/chat-archive.ts";
import type { ChatMessage } from "../vibey/chat-archive.ts";
import { fetchLiveMembers } from "../vibey/live-members.ts";
import { fetchLiveTail, mergeArchiveAndTail } from "../vibey/live-tail.ts";
import { matchPerson } from "../vibey/roster.ts";
import { groupJidFromAuth } from "../vibey/session.ts";

/**
 * "Who is X" lookup. Resolves a curated profile from the people data (role, org,
 * what they build, in-chat takes) AND computes live detail from the chat archive
 * for the same person — message count + rank, the dates they've been active, the
 * topics they talk about most, and a representative message. Either half can be
 * empty: a member with a profile but no archive hits still resolves, and someone
 * who's chatted but isn't separately profiled still gets the computed half. So
 * the agent can say something useful about anyone in the group, not just the
 * names hard-coded in the prompt.
 */

// The current-member roster as match targets, so the same loose name matching
// (full name / first name / alias / >=3-char substring) resolves a query to it.
// A function, not a constant: the overlay is a file on the volume.
const memberRoster = () => memberNames().map((name) => ({ name }));

const trunc = (x: string) => (x.length > 240 ? `${x.slice(0, 240)}…` : x);

/**
 * A query that's really a raw WhatsApp id, not a name — e.g. an unresolved
 * `@lid` mention that leaked through as digits. Matching it against archive
 * senders would aggregate an unrelated bucket and confidently describe the wrong
 * person, so we decline instead. "Mostly digits" (>=6 chars, <2 letters) catches
 * phone/lid user-parts without tripping on real names.
 */
const looksLikeRawId = (name: string): boolean => {
  const s = name.replaceAll(/[@\s]/gu, "");
  if (s.length < 6) {
    return false;
  }
  const letters = (s.match(/[a-z]/giu) ?? []).length;
  const digits = (s.match(/\d/gu) ?? []).length;
  return digits >= 6 && letters < 2;
};
const reactionScore = (m: ChatMessage): number => {
  let total = 0;
  for (const { n } of m.r ?? []) {
    total += n;
  }
  return total;
};

/**
 * Does an archive sender name correspond to this person? Exact match always
 * counts; substring matches are guarded to >=3 chars (mirroring matchPerson) so
 * a short raw query like "me" can't aggregate unrelated senders ("James").
 */
const senderMatches = (senderLc: string, candidates: string[]): boolean =>
  candidates.some((c) => {
    const cand = c.toLowerCase();
    if (senderLc === cand) {
      return true;
    }
    return cand.length >= 3 && (senderLc.includes(cand) || cand.includes(senderLc));
  });

// Chat noise on top of bm25's stopwords: media placeholders, URL fragments, and
// high-frequency conversational filler that says nothing about what someone's into.
const NOISE = new Set(
  "omitted image video media sticker message edited deleted https http www com net org html just can all not get got like one would could should really actually yeah yep nah lol haha thanks thank cheers yes no okay ok dont didnt im ive its theres thats gonna wanna think know see good nice cool great oh ah hey lot bit way using used use try trying make making want need anyone someone everyone here there how about out now then some more been much very going still even also something anything everything well sure right maybe probably pretty kind sort stuff things thing day today week people person guy guys this that they them what when where why who him her our your".split(
    " ",
  ),
);

/** Top content terms in a person's messages (own-name + noise tokens removed). */
const topicHints = (messages: ChatMessage[], nameTokens: Set<string>): string[] => {
  const freq = new Map<string, number>();
  for (const m of messages) {
    // Drop URLs and WhatsApp's <…> system markers ("<Media omitted>", "<This
    // message was edited>") before tokenising so their words don't rank as topics.
    const text = m.x.replaceAll(/https?:\/\/\S+|<[^>]*>/gu, " ");
    for (const tok of tokenize(text)) {
      if (tok.length >= 3 && !nameTokens.has(tok) && !NOISE.has(tok)) {
        freq.set(tok, (freq.get(tok) ?? 0) + 1);
      }
    }
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 3)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([term]) => term);
};

const formatReactions = (r?: { e: string; n: number }[]): string | undefined =>
  r?.length ? r.map(({ e, n }) => `${e}×${n}`).join(" ") : undefined;

/**
 * Current membership. `onRoster` is the live WhatsApp set when the bridge
 * answered, otherwise the git overlay. A curated `member: false` is never in
 * the group. On the roster ⇒ in; profile or posts but not on the roster ⇒
 * left; nothing at all ⇒ unknown.
 */
const membership = (
  profile: PersonProfile | undefined,
  onRoster: boolean,
  hasPosts: boolean,
): boolean | undefined => {
  if (profile?.member === false) {
    return false;
  }
  if (onRoster) {
    return true;
  }
  if (profile || hasPosts) {
    return false;
  }
  return undefined;
};

/** How many senders out-posted this person (their rank is this + 1). */
const countAhead = (counts: Map<string, number>, total: number): number => {
  let ahead = 0;
  for (const c of counts.values()) {
    if (c > total) {
      ahead += 1;
    }
  }
  return ahead;
};

/**
 * A representative message: the most-reacted one, falling back to the most
 * recent. `>=` lets ties go to the later message, so with no reactions the latest
 * wins. `mine` is always non-empty at the call site.
 */
const pickSample = (mine: ChatMessage[]): ChatMessage => {
  let [best] = mine;
  let bestScore = reactionScore(best);
  for (const m of mine) {
    const score = reactionScore(m);
    if (score >= bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
};

export default defineTool({
  description:
    "Look up a VCMC member by name: their current role/company and links (LinkedIn, GitHub, X), what they build, plus computed activity from the chat archive (message count and rank, when they've been active, the topics they talk about most, and a representative message). Use for 'who is X', 'what does X work on', 'what's X into', 'what's X's LinkedIn/GitHub', 'tell me about X'. Resolves anyone who's chatted, not just well-known members; says so plainly if there's nothing on a name.",
  async execute(input, ctx) {
    // A raw id (an @mention that didn't resolve to a name) can't identify anyone
    // — decline rather than fuzzy-matching a stranger by their digits.
    if (looksLikeRawId(input.name)) {
      return {
        found: false,
        note: "That looks like a raw @mention id that didn't resolve to a name, so I can't tell who was tagged. Ask again with their actual name.",
        query: input.name,
      };
    }

    // Live WhatsApp set when the bridge is up; git overlay when it isn't.
    // A joiner is on the live list before anyone edits members.ts; a leaver
    // is off it even if their overlay row remains. Fetched in parallel with
    // the chat tail — both are independent bridge GETs.
    const jid = groupJidFromAuth(ctx.session.auth);
    const [liveMembers, tail] = await Promise.all([fetchLiveMembers(), fetchLiveTail(jid)]);
    const liveAvailable = liveMembers !== null;
    const liveProfile = liveAvailable ? matchPerson(liveMembers, input.name) : undefined;
    const gitProfile = matchPerson(people(), input.name);
    // Prefer the live row (has current membership + overlay fields when we
    // know them); fall back to the git profile so a leaver still resolves.
    const profile = liveProfile ?? gitProfile;

    // Names to match archive senders against: the resolved profile's name +
    // aliases (more reliable than the raw query), else the query itself.
    const candidates = profile ? [profile.name, ...(profile.aliases ?? [])] : [input.name];

    const messages = mergeArchiveAndTail(loadArchive(), tail);

    // Per-sender counts for the leaderboard, plus this person's own messages.
    const counts = new Map<string, number>();
    const mine: ChatMessage[] = [];
    for (const m of messages) {
      counts.set(m.s, (counts.get(m.s) ?? 0) + 1);
      if (senderMatches(m.s.toLowerCase(), candidates)) {
        mine.push(m);
      }
    }

    // Live set is membership when the bridge answered; otherwise the git
    // overlay snapshot (hedged — it drifts until the next enrich).
    const onRoster = liveAvailable
      ? liveProfile !== undefined
      : candidates.some((c) => matchPerson(memberRoster(), c) !== undefined);
    const isMember = membership(profile, onRoster, mine.length > 0);

    if (mine.length === 0) {
      // No chat footprint. Still useful if we have a profile or roster entry.
      if (profile || onRoster) {
        return {
          found: true,
          member: isMember ?? true,
          note:
            isMember === false
              ? "Has a profile but isn't in the current member roster (may have left)."
              : "In the group, but no messages found in the archive.",
          profile: profile ?? null,
          stats: null,
        };
      }
      return {
        found: false,
        note: "No profile and no messages found for that name. Try search-chat, or they may not be in the group.",
        query: input.name,
      };
    }

    const total = mine.length;
    const dates = mine.map((m) => m.t);
    const nameTokens = new Set(candidates.flatMap((c) => tokenize(c)));
    const sample = pickSample(mine);

    return {
      found: true,
      member: isMember,
      // Posted but not on the current roster: most likely left the group, though
      // they could just appear under a different name in the roster snapshot.
      note:
        isMember === false
          ? "Has history in the chat but isn't in the current member roster (may have left)."
          : undefined,
      profile: profile ?? null,
      stats: {
        activeFrom: dates.at(0) ?? null,
        activeTo: dates.at(-1) ?? null,
        messages: total,
        participants: counts.size,
        rank: countAhead(counts, total) + 1,
        sample: {
          date: sample.t,
          reactions: formatReactions(sample.r),
          text: trunc(sample.x),
        },
        topics: topicHints(mine, nameTokens),
      },
    };
  },
  inputSchema: z.object({
    name: z
      .string()
      .describe(
        "The person to look up (e.g. 'Marcus', 'Ben Flint', 'Benji'). Matches full name, first name, or a known alias.",
      ),
  }),
});
