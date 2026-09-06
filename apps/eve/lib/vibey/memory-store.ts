import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

/**
 * Durable storage for everything @vibey *authors* — group memory today, the
 * write-loop audit log and daily episodes next — on Vercel Blob.
 *
 * The split this draws: the Railway bridge owns what WhatsApp *produces*
 * (messages, reactions, resources, the socket, the login — all Baileys-coupled
 * and all needing a long-lived process with a volume). Vercel owns what the
 * agent writes. Before this, memory lived on the bridge volume purely because
 * that's where a volume already existed, which cost a cross-region HTTP hop in
 * front of every single reply and left the data with no backup.
 *
 * Why Blob rather than a KV: `put` supports `ifMatch`, so a read-modify-write is
 * atomic without a lock. The bridge's `withFileLock` is a per-process in-memory
 * Map, which meant correctness quietly depended on never running more than one
 * bridge replica. Nothing here depends on that.
 *
 * eve deliberately ships no storage primitive of its own — `docs/patterns/
 * multi-tenant-memory.md` says "The storage implementation is deliberately
 * outside eve" and prescribes exactly this shape: a small scope-keyed adapter
 * behind read/write helpers, with the scope taken from verified session auth
 * and never from the model.
 */

/** One prose block per category, exactly as the prompt renders it. */
export type GroupMemory = Record<string, string>;

/** True when a Blob store is wired up. False in the eve TUI and bare checkouts. */
export const blobConfigured = (): boolean =>
  Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

/**
 * Blob pathnames are flat strings, so a JID has to be flattened. Matches the
 * bridge's `safe()` so a migrated file lands on a predictable, greppable path.
 */
export const safeJid = (jid: string): string => jid.replaceAll(/[^a-zA-Z0-9]/gu, "_");

/**
 * Optional namespace in front of every key this module owns.
 *
 * `BLOB_READ_WRITE_TOKEN` lives in `.env.local`, so anything run locally —
 * including `eve eval` — reads and writes the *production* store. A fixture
 * eval without this would land in the real group's memory. Setting
 * `MEMORY_BLOB_PREFIX` moves the whole namespace sideways instead.
 *
 * Unset (the deployment, and every existing test) it is the empty string, so
 * production pathnames are byte-identical to what they were before it existed —
 * pinned by a test, because a stray prefix here silently orphans live memory.
 * Read per call rather than at module load so a test can set it.
 */
const blobPrefix = (): string => {
  const raw = process.env.MEMORY_BLOB_PREFIX?.trim() ?? "";
  return raw ? `${raw.replace(/\/+$/u, "")}/` : "";
};

/** Where a group's memory lives. */
export const memoryKey = (groupJid: string): string =>
  `${blobPrefix()}memory/${safeJid(groupJid)}.json`;

interface ReadResult<T> {
  value: T;
  /** Pass to `writeJson` as `ifMatch` to make the write conditional. */
  etag: string;
}

/**
 * Drop the `W/` weak-validator prefix from an ETag.
 *
 * Load-bearing, and the fix for a bug that silently disabled every write to
 * this store. Once a blob's body exceeds ~1KB it is served compressed, and a
 * compressed representation gets a *weak* ETag: `W/"<hash>"` rather than
 * `"<hash>"`. `put`'s `ifMatch` compares strongly, so passing the weak form
 * back fails the precondition every single time — deterministically, for the
 * life of the blob, no matter what anyone else is doing.
 *
 * `mutateJson` reads that failure as a lost race, so the symptom was the whole
 * store going read-only above 1KB while reporting "contended for 4 attempts".
 * Group memory crossed the threshold on 2026-08-09 and the overnight pass
 * failed the next night; the audit log crossed it three days earlier and had
 * been dropping entries silently the whole time.
 *
 * The hash inside the weak form is the same strong validator the store holds,
 * so stripping the prefix is exact, not an approximation.
 */
const strongEtag = (etag: string): string => etag.replace(/^W\//u, "");

/**
 * Read and parse a JSON blob. `null` means "not there, or we couldn't tell" —
 * callers must not treat that as empty (see `fetchGroupMemory`, where conflating
 * the two used to let an outage trigger a destructive overwrite).
 *
 * `fresh` bypasses the CDN cache. Reads are cached by default because the hot
 * path runs in front of every reply and a cache hit is both faster and unbilled;
 * writers pass `fresh: true` because a stale read would make `ifMatch` fail on
 * every attempt and burn the retry budget for nothing.
 */
export const readJson = async <T>(
  pathname: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<ReadResult<T> | null> => {
  if (!blobConfigured()) {
    return null;
  }
  try {
    const res = await get(pathname, { access: "private", useCache: !fresh });
    if (!res || res.statusCode !== 200) {
      return null;
    }
    const text = await new Response(res.stream).text();
    return { etag: strongEtag(res.blob.etag), value: JSON.parse(text) as T };
  } catch {
    // Missing blob, malformed JSON, network — all "we don't know".
    return null;
  }
};

/**
 * Write a JSON blob. With `ifMatch` the write only lands if the blob is
 * unchanged since it was read; without it, the write only lands if the blob
 * does not exist yet. Both failure modes surface as
 * `BlobPreconditionFailedError` so `mutateJson` can retry uniformly.
 */
export const writeJson = async (pathname: string, value: unknown, etag?: string): Promise<void> => {
  await put(pathname, JSON.stringify(value, null, 2), {
    access: "private",
    // No etag means "we believe this is a create". allowOverwrite:false turns a
    // lost create race into an error instead of silently clobbering the winner.
    allowOverwrite: Boolean(etag),
    contentType: "application/json",
    ...(etag ? { ifMatch: etag } : {}),
  });
};

/** How many times a losing writer retries before giving up. */
const MAX_ATTEMPTS = 4;

/**
 * Atomic read-modify-write. `mutate` receives the current value (or `null` when
 * the blob doesn't exist yet) and returns the next one; returning `null` aborts
 * the write. Retries on a lost race, so concurrent writers serialise without a
 * lock — this is what replaces the bridge's single-process file lock, and it's
 * why the overnight write loop and a live admin save can't clobber each other.
 */
export const mutateJson = async <T>(
  pathname: string,
  mutate: (current: T | null) => T | null,
): Promise<T | null> => {
  let lastEtag: string | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // Sequential by definition: each attempt must observe the result of the
    // previous one. Running these concurrently is precisely the bug this guards
    // against, so the loop-await lint is disabled deliberately here.
    // oxlint-disable-next-line no-await-in-loop -- retry must be sequential
    const read = await readJson<T>(pathname, { fresh: true });

    // A conditional write that failed against an etag the blob still has was
    // never a race: nobody moved it between our reads, so retrying can only
    // produce the same rejection three more times and then a wrong diagnosis.
    // The weak-etag bug above spent days looking like contention because this
    // said "contended"; say what actually happened instead.
    if (read && read.etag === lastEtag) {
      throw new Error(
        `memory-store: ${pathname} rejected a conditional write on etag ${read.etag}, but the blob has not changed — this is not contention`,
      );
    }
    lastEtag = read?.etag;

    const next = mutate(read?.value ?? null);
    if (next === null) {
      return null;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- retry must be sequential
      await writeJson(pathname, next, read?.etag);
      return next;
    } catch (error) {
      // Someone else wrote between our read and our put. Re-read and reapply —
      // the mutation runs against their value, not a stale one, so both edits
      // survive. Any other error is real and must not be swallowed.
      const lostRace =
        error instanceof BlobPreconditionFailedError ||
        // A create race (no etag, allowOverwrite:false) reports as a plain
        // "blob already exists" rather than a precondition failure.
        (!read && /already exists/iu.test(String(error)));
      if (!lostRace) {
        throw error;
      }
    }
  }
  throw new Error(`memory-store: ${pathname} contended for ${MAX_ATTEMPTS} attempts`);
};

/**
 * A group's stored memory, or `null` when the store is unreachable or the group
 * has nothing yet. Callers distinguish those two only via `blobConfigured()`;
 * for the prompt they render identically, and for a *write* both are safe
 * because the write is a merge, not a replace.
 */
export const readGroupMemory = async (groupJid: string): Promise<GroupMemory | null> => {
  const read = await readJson<GroupMemory>(memoryKey(groupJid));
  return read?.value ?? null;
};

/**
 * Replace one category's prose, leaving the others untouched. The merge happens
 * inside the atomic retry, so a concurrent write to a *different* category is
 * preserved rather than lost — which the old whole-file rewrite could not
 * guarantee across processes.
 */
export const writeGroupMemoryCategory = async (
  groupJid: string,
  category: string,
  content: string,
): Promise<GroupMemory | null> =>
  await mutateJson<GroupMemory>(memoryKey(groupJid), (current) => ({
    ...current,
    [category]: content,
  }));

/** One recorded change to memory. `source` is what makes a write revertable. */
export interface MemoryWrite {
  id: string;
  category: string;
  /** Full prose written, so a revert can restore the prior value verbatim. */
  content: string;
  /** What this replaced — `null` when the category was previously unset. */
  previous: string | null;
  by: string;
  reason: string;
  /**
   * `"admin"` means a human asked for this write, `"auto"` means the overnight
   * pass made it on its own. The name predates the admin gate being removed and
   * is kept because it is persisted in every historical log entry; read it as
   * "a person", not "a privileged person".
   */
  source: "admin" | "auto";
  t: number;
}

/** UTC day key. Audit blobs are per-day so they stay small and list in order. */
export const dayKey = (at: Date): string => at.toISOString().slice(0, 10);

/** Where a group's audit trail lives. Exported so a fixture can tear it down. */
export const auditKey = (groupJid: string): string =>
  `${blobPrefix()}audit/${safeJid(groupJid)}.json`;

/** ~4 months of nightly writes plus manual saves. Oldest fall off the front. */
const MAX_WRITES = 500;

/**
 * Append to the audit trail. Takes a list because the overnight pass records
 * several writes at once: appending them individually would fire N concurrent
 * read-modify-writes at the same blob, and once they exhaust the retry budget
 * `mutateJson` throws and the entry is silently dropped — losing the record for
 * exactly the writes that most need one.
 *
 * Best-effort by design: losing an audit line must never fail the save that
 * produced it. The write itself is the thing that matters.
 */
export const appendMemoryWrites = async (
  groupJid: string,
  entries: readonly MemoryWrite[],
): Promise<void> => {
  if (!(blobConfigured() && entries.length > 0)) {
    return;
  }
  try {
    await mutateJson<MemoryWrite[]>(auditKey(groupJid), (current) =>
      [...(current ?? []), ...entries].slice(-MAX_WRITES),
    );
  } catch (error) {
    // Swallowed on purpose (see above) but never silent: three days of audit
    // entries went missing to the weak-etag bug with nothing in the log to say
    // so, which left autonomous writes that had already landed with no record
    // and no way to revert them.
    console.error(`[memory-store] audit append failed: ${String(error)}`);
  }
};

/** Convenience for the single-entry callers (manual saves, reverts). */
export const appendMemoryWrite = async (groupJid: string, entry: MemoryWrite): Promise<void> => {
  await appendMemoryWrites(groupJid, [entry]);
};

/** The stored audit trail, oldest last. One read. */
export const readMemoryWrites = async (groupJid: string): Promise<MemoryWrite[]> => {
  if (!blobConfigured()) {
    return [];
  }
  const read = await readJson<MemoryWrite[]>(auditKey(groupJid));
  return read?.value ?? [];
};

/**
 * A day's recap, kept after it's been sent.
 *
 * The digest already spends a model call summarising the group every morning
 * and then throws the result away. Keeping it turns compute we've already paid
 * for into a searchable episodic record: the memory categories hold standing
 * facts ("Marcus is at Canva"), this holds what actually happened on a day.
 */
export interface Episode {
  day: string;
  style: string;
  text: string;
  messageCount: number;
  t: number;
}

/**
 * All of a group's recaps in one blob.
 *
 * One blob per day would mean guessing a date window and firing that many GETs
 * on every read — and recaps are read by `search-chat`, the hot path. A single
 * capped array is one read instead of sixty, and writes happen once a day so
 * there is no contention to speak of.
 */
export const episodesKey = (groupJid: string): string =>
  `${blobPrefix()}episodes/${safeJid(groupJid)}.json`;

/** ~4 months of daily recaps. Oldest fall off the front. */
const MAX_EPISODES = 120;

/**
 * Store a day's recap. One canonical episode per day per group: two subscribers
 * on different styles would otherwise leave two overlapping summaries of the
 * same day and the model would cite whichever ranked higher. First writer wins,
 * so the earliest local morning sets the record.
 */
export const recordEpisode = async (groupJid: string, episode: Episode): Promise<boolean> => {
  if (!blobConfigured()) {
    return false;
  }
  try {
    const written = await mutateJson<Episode[]>(episodesKey(groupJid), (current) => {
      const existing = current ?? [];
      // null aborts the write: the day is already recorded, and rewriting the
      // array byte-for-byte would cost a billed operation for nothing.
      if (existing.some((e) => e.day === episode.day)) {
        return null;
      }
      return [...existing, episode].slice(-MAX_EPISODES);
    });
    return written !== null;
  } catch (error) {
    // Same reasoning as the audit append: best-effort, but say so out loud.
    console.error(`[memory-store] episode write failed: ${String(error)}`);
    return false;
  }
};

/** Every stored recap, oldest first. One read. */
export const readEpisodes = async (groupJid: string): Promise<Episode[]> => {
  if (!blobConfigured()) {
    return [];
  }
  const read = await readJson<Episode[]>(episodesKey(groupJid));
  return read?.value ?? [];
};
