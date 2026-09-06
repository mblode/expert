import { gunzipSync } from "node:zlib";

import { readArchiveSource } from "./chat-archive-source.ts";
import { buildBm25 } from "./bm25.ts";
import type { Bm25Index } from "./bm25.ts";

/**
 * The embedded VCMC chat archive (~11.5k messages, Mar 2025 – Jul 2026), shipped
 * gzipped+base64 so it travels with the deployment without a database. Decoded
 * and parsed once per process and cached, so multiple tools (search-chat,
 * get-group-stats) share a single in-memory copy.
 */

/** An aggregated emoji reaction on a message: emoji + how many people used it. */
export interface Reaction {
  e: string;
  n: number;
}

export interface ChatMessage {
  /** Date as "D/M/YYYY" (kept for dedup + back-compat with the original export). */
  t: string;
  /** Sender display name ("who"). */
  s: string;
  /** Message text. */
  x: string;
  /** Unix seconds (precise time), when known (richer rows from the wacli import). */
  ts?: number;
  /** Aggregated emoji reactions, when any (from the wacli import). */
  r?: Reaction[];
}

let cached: ChatMessage[] | null = null;

/**
 * Decode + parse the archive once; cached for the process lifetime. A
 * computer with no archive file gets an empty archive, and `archiveAvailable`
 * is how a tool tells that apart from a community that has said nothing.
 */
export const loadArchive = (): ChatMessage[] => {
  if (!cached) {
    const source = readArchiveSource();
    cached = source
      ? (JSON.parse(gunzipSync(Buffer.from(source, "base64")).toString("utf-8")) as ChatMessage[])
      : [];
  }
  return cached;
};

/** True when this computer carries a chat archive at all. */
export const archiveAvailable = (): boolean => loadArchive().length > 0;

/** Test seam: forget the decoded archive so the next call re-reads the file. */
export const resetArchiveCache = (): void => {
  cached = null;
  cachedIndex = null;
};

let cachedIndex: { messages: ChatMessage[]; index: Bm25Index } | null = null;

/**
 * Shared BM25 index over the archive, indexing "Sender: text" so a person's name
 * is a lexical signal. Built once and reused by every caller (search-chat,
 * audit-memory) so the ~9k-message index isn't held in memory twice.
 */
export const getArchiveIndex = (): {
  messages: ChatMessage[];
  index: Bm25Index;
} => {
  if (!cachedIndex) {
    const messages = loadArchive();
    cachedIndex = {
      index: buildBm25(messages.map((m) => `${m.s}: ${m.x}`)),
      messages,
    };
  }
  return cachedIndex;
};
