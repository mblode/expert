import { mkdir, appendFile, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

/**
 * Tiny append-only message/resource buffer backed by the per-account data directory on the tenant volume.
 *
 * One JSONL file per group/DM under <dataDir>/messages and <dataDir>/resources.
 * Files are trimmed to the last `cap` lines so the volume can't grow forever.
 * Messages and reactions get their own (larger) caps so a history backfill isn't
 * trimmed away. No database, the bridge is the only writer and reader.
 *
 * A message record is `{ t, s, n, x }` (unix seconds, sender user-part, sender
 * name, text). Records may also carry optional `role` ("user" | "assistant",
 * marking who sent it) and `surface` ("dm" | "group", where it was sent) fields.
 *
 * Small bits of cross-restart state (processed message ids, per-group backfill
 * anchors, the lid map, the live participant set) live as JSON under
 * <dataDir>/state.
 */

/** A stored message record. */
export interface MessageRecord {
  id?: string;
  n?: string | null;
  role?: "user" | "assistant";
  s: string;
  surface?: "dm" | "group";
  t: number;
  x: string;
}

/** A stored resource (shared URL) record. */
export interface ResourceRecord {
  n?: string | null;
  s: string;
  t: number;
  url: string;
}

/** A stored reaction record. */
export interface ReactionRecord {
  emoji: string;
  /** Reactor display name, resolved from messages at capture time (best-effort). */
  n?: string | null;
  s: string;
  t: number;
  target: string;
}

/** Oldest-known message per group, the anchor for on-demand backfill. */
export interface Anchor {
  fromMe: boolean;
  id?: string | null;
  ts: number;
}

/** Map of group jid -> backfill anchor. */
export type Anchors = Record<string, Anchor>;

/**
 * What we've learned about a WhatsApp @lid: the phone it pairs with (so a lid
 * mention resolves to the phone-keyed member roster) and the last pushName we
 * saw for it. Persisted so mention resolution survives a bridge restart, a
 * deploy would otherwise drop the in-memory map and the first mention after it
 * comes through as raw digits.
 */
export interface LidEntry {
  phone?: string;
  name?: string;
}

/** Map of @lid user-part -> learned phone/name. */
export type LidMap = Record<string, LidEntry>;

/** Options for createStore. */
export interface StoreOptions {
  cap?: number;
  messagesCap?: number;
  reactionsCap?: number;
}

/** The public surface of the message/resource store. */
export interface Store {
  allMessages: (jid: string) => Promise<MessageRecord[]>;
  loadAnchors: () => Promise<Anchors>;
  loadLidMap: () => Promise<LidMap>;
  loadParticipants: () => Promise<unknown>;
  loadProcessedIds: () => Promise<string[]>;
  recentMessages: (jid: string, n: number) => Promise<MessageRecord[]>;
  recentReactions: (jid: string, n: number) => Promise<ReactionRecord[]>;
  recentResources: (jid: string, n: number) => Promise<ResourceRecord[]>;
  recordMessage: (jid: string, entry: MessageRecord) => Promise<void>;
  recordReaction: (jid: string, entry: ReactionRecord) => Promise<void>;
  recordResource: (jid: string, entry: ResourceRecord) => Promise<void>;
  saveAnchors: (obj: Anchors) => Promise<void>;
  saveLidMap: (obj: LidMap) => Promise<void>;
  saveParticipants: (obj: unknown) => Promise<void>;
  saveProcessedIds: (ids: string[]) => Promise<void>;
}

const safe = (jid: string): string => jid.replaceAll(/[^a-z0-9]/giu, "_");

const ensure = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
};

const parseLines = <T>(raw: string): T[] =>
  raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as T[];

// Serialize every mutation to a given file path. Without this, a concurrent
// appendFile + trimFile (read whole file, slice, rename) can drop a line that
// landed between trimFile's readFile and its rename, and two writers can also
// collide on the identical `${file}.tmp` name. Chaining each op after the
// previous one for that path makes all writes to a path strictly ordered.
const writeLocks = new Map<string, Promise<unknown>>();

const withFileLock = <T>(file: string, fn: () => Promise<T>): Promise<T> => {
  const prev = writeLocks.get(file) ?? Promise.resolve();
  // Run fn after any pending op on this path; swallow the predecessor's result
  // (and error) so one failed write can't reject every queued follow-up.
  const next = (async () => {
    try {
      await prev;
    } catch {
      // the predecessor's failure belongs to its own caller, not this op
    }
    return fn();
  })();
  // Keep the tail so later callers chain after this op.
  writeLocks.set(file, next);
  // Clear the entry once it's the tail and has settled, so the map doesn't
  // grow unbounded. Runs detached; never rejects.
  const releaseWhenSettled = async (): Promise<void> => {
    try {
      await next;
    } catch {
      // failure is surfaced to the caller via `next`; nothing to do here
    }
    if (writeLocks.get(file) === next) {
      writeLocks.delete(file);
    }
  };
  void releaseWhenSettled();
  return next;
};

// The trim itself, assuming the caller already holds the file lock.
const trimFileUnlocked = async (file: string, lineCap: number): Promise<void> => {
  try {
    const contents = await readFile(file, "utf-8");
    const lines = contents.split("\n").filter(Boolean);
    if (lines.length > lineCap) {
      // Write to a temp file then rename so a crash mid-write can't corrupt
      // the buffer (rename is atomic on the same filesystem).
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${lines.slice(-lineCap).join("\n")}\n`);
      await rename(tmp, file);
    }
  } catch {
    // file may not exist yet; ignore
  }
};

export const createStore = (
  dataDir: string,
  { cap = 2000, messagesCap = cap, reactionsCap = cap }: StoreOptions = {},
): Store => {
  const messagesDir = path.join(dataDir, "messages");
  const resourcesDir = path.join(dataDir, "resources");
  const reactionsDir = path.join(dataDir, "reactions");
  const stateDir = path.join(dataDir, "state");
  const appendsSinceTrim = new Map<string, number>();

  const append = async (dir: string, jid: string, obj: unknown, lineCap = cap): Promise<void> => {
    await ensure(dir);
    const file = path.join(dir, `${safe(jid)}.jsonl`);
    // Append and any follow-up trim must run as one locked unit so a concurrent
    // writer can't slip a trim between them and drop this just-appended line.
    await withFileLock(file, async () => {
      await appendFile(file, `${JSON.stringify(obj)}\n`);
      // Trim every 200 appends, and once on the first append per file each process
      // start (the counter resets on restart, so this bounds growth across redeploys).
      const first = !appendsSinceTrim.has(file);
      const n = (appendsSinceTrim.get(file) ?? 0) + 1;
      if (first || n >= 200) {
        appendsSinceTrim.set(file, 0);
        await trimFileUnlocked(file, lineCap);
      } else {
        appendsSinceTrim.set(file, n);
      }
    });
  };

  const readLast = async <T>(dir: string, jid: string, n: number): Promise<T[]> => {
    const file = path.join(dir, `${safe(jid)}.jsonl`);
    try {
      const contents = await readFile(file, "utf-8");
      return parseLines<T>(contents).slice(-n);
    } catch {
      return [];
    }
  };

  /** Read the whole JSONL file for a jid (used by /export for reingest). */
  const readAll = async <T>(dir: string, jid: string): Promise<T[]> => {
    const file = path.join(dir, `${safe(jid)}.jsonl`);
    try {
      const contents = await readFile(file, "utf-8");
      return parseLines<T>(contents);
    } catch {
      return [];
    }
  };

  /** Read a small JSON state file (best-effort; returns fallback on any error). */
  const readState = async <T>(name: string, fallback: T): Promise<T> => {
    try {
      const obj = JSON.parse(await readFile(path.join(stateDir, name), "utf-8")) as T;
      return obj ?? fallback;
    } catch {
      return fallback;
    }
  };

  /** Write a small JSON state file atomically (temp + rename). */
  const writeState = async (name: string, obj: unknown): Promise<void> => {
    await ensure(stateDir);
    const file = path.join(stateDir, name);
    // Serialize per state file so concurrent saves don't collide on the shared
    // `${file}.tmp` name mid-rename.
    await withFileLock(file, async () => {
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(obj));
      await rename(tmp, file);
    });
  };

  return {
    allMessages: (jid) => readAll<MessageRecord>(messagesDir, jid),
    async loadAnchors() {
      const obj = await readState<Anchors>("anchors.json", {});
      return obj && typeof obj === "object" ? obj : {};
    },
    async loadLidMap() {
      const obj = await readState<LidMap>("lidmap.json", {});
      return obj && typeof obj === "object" ? obj : {};
    },
    async loadParticipants() {
      return await readState<unknown>("participants.json", {});
    },
    async loadProcessedIds() {
      const arr = await readState<unknown>("processed-ids.json", []);
      return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
    },
    recentMessages: (jid, n) => readLast<MessageRecord>(messagesDir, jid, n),
    recentReactions: (jid, n) => readLast<ReactionRecord>(reactionsDir, jid, n),
    recentResources: (jid, n) => readLast<ResourceRecord>(resourcesDir, jid, n),
    recordMessage: (jid, entry) => append(messagesDir, jid, entry, messagesCap),
    recordReaction: (jid, entry) => append(reactionsDir, jid, entry, reactionsCap),
    recordResource: (jid, entry) => append(resourcesDir, jid, entry),
    saveAnchors: (obj) => writeState("anchors.json", obj),
    saveLidMap: (obj) => writeState("lidmap.json", obj),
    saveParticipants: (obj) => writeState("participants.json", obj),
    saveProcessedIds: (ids) => writeState("processed-ids.json", ids),
  };
};

/** Extract http(s) URLs from a message body. */
export const extractUrls = (text: string): string[] => {
  const matches = text.match(/https?:\/\/[^\s<>()]+/giu) ?? [];
  // Trim common trailing punctuation that isn't part of the URL.
  return matches.map((u) => u.replace(/[.,;:!?)\]]+$/u, ""));
};
