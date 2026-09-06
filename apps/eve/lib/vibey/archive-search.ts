import { getArchiveIndex } from "./chat-archive.ts";
import type { ArchiveHit } from "./stale-scan.ts";

/**
 * Lexical lookup over the embedded chat archive, used to ask "is this roster
 * member still mentioned anywhere" for the possibly-left signal.
 *
 * Reuses the shared BM25 index from `chat-archive.js` that `search-chat` also
 * builds, so the ~11k-message index isn't held twice. Lifted out of
 * `agent/tools/audit-memory.ts` so the overnight consolidation schedule runs
 * against exactly the same implementation the on-demand audit does — two copies
 * would drift, and the whole point of the loop is that its proposals match what
 * an admin would see if they asked.
 */
export const archiveSearch = (query: string): ArchiveHit[] => {
  const { messages, index } = getArchiveIndex();
  return index.search(query, 5).map(({ index: i }) => {
    const m = messages[i];
    return { date: m.t, from: m.s, text: m.x };
  });
};
