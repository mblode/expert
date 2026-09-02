import { randomBytes, timingSafeEqual } from "node:crypto";
import { ComputerError } from "@computer/shared";
import { readTokenFile, writeTokenFile } from "./provision.ts";

/**
 * Channels: the doors through which something other than a seat reaches a
 * Bot's Eve. The WhatsApp bridge on this Machine, a webhook, a Slack app.
 * Each one is a record here with its own secret, so a channel is revoked or
 * rotated on its own and never borrows a seat token (which is a human's and
 * owns the box) or the hub→Eve secret (which is loopback plumbing).
 *
 * The ingress (`handler/channels.ts`) maps `/channels/<id>/<rest>` onto the
 * Bot's Eve at `/eve/v1/<kind>/<rest>`: the id picks the record and the
 * Bot, the kind picks the Eve channel file. `paths`, when set, narrows which
 * Eve routes this door may reach.
 */
export interface ChannelRecord {
  id: string;
  /** The Eve channel kind, e.g. `whatsapp`: the route prefix under /eve/v1. */
  kind: string;
  bot: string;
  secret: string;
  paths?: string[];
  created_at: string;
}

/** What a list may show: everything but the secret. */
export type ChannelSummary = Omit<ChannelRecord, "secret">;

export interface ChannelStore {
  load(): ChannelRecord[];
  save(records: ChannelRecord[]): void;
}

export class MemoryChannelStore implements ChannelStore {
  private records: ChannelRecord[] = [];

  load(): ChannelRecord[] {
    return this.records;
  }

  save(records: ChannelRecord[]): void {
    this.records = records;
  }
}

/** `channels.json` beside the roster: same 0600 file discipline, same reason. */
export class FileChannelStore implements ChannelStore {
  constructor(private readonly path: string) {}

  load(): ChannelRecord[] {
    const parsed = readTokenFile(this.path, "channels");
    if (parsed === undefined) {
      return [];
    }
    return parsed.map((entry) => channelRecordFrom(entry, this.path));
  }

  save(records: ChannelRecord[]): void {
    writeTokenFile(this.path, records);
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const KIND_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function channelRecordFrom(entry: unknown, path: string): ChannelRecord {
  if (!entry || typeof entry !== "object") {
    throw new Error(`channels ${path} must be a JSON array of channel records`);
  }
  const r = entry as Partial<ChannelRecord>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) {
    throw new Error(`channels ${path}: a record has a bad id`);
  }
  if (typeof r.kind !== "string" || !KIND_RE.test(r.kind)) {
    throw new Error(`channels ${path}: channel ${r.id} has a bad kind`);
  }
  if (typeof r.bot !== "string" || !r.bot) {
    throw new Error(`channels ${path}: channel ${r.id} has no bot`);
  }
  if (typeof r.secret !== "string" || !r.secret) {
    throw new Error(`channels ${path}: channel ${r.id} has no secret`);
  }
  return {
    bot: r.bot,
    created_at: typeof r.created_at === "string" ? r.created_at : "1970-01-01T00:00:00.000Z",
    id: r.id,
    kind: r.kind,
    paths: Array.isArray(r.paths) ? r.paths.filter((x) => typeof x === "string") : undefined,
    secret: r.secret,
  };
}

export function mintChannelSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Stateless over its store on purpose: `npm run bot -- channel add` edits
 * `channels.json` behind a running hub, and a registry that cached the file
 * at boot would neither see that door nor keep it on its next write. The
 * file is a handful of records, so reading it per call costs nothing.
 *
 * No lockout here, unlike `Pair`. The ingress is public and a channel id is
 * guessable (`whatsapp-<acct>`), so a per-id lockout would let anyone on the
 * internet block the real bridge for a minute at a time with ten junk
 * requests. A 256-bit secret is not an online-guessing target; the
 * constant-time compare is the whole defence.
 */
export class ChannelRegistry {
  constructor(private readonly store: ChannelStore = new MemoryChannelStore()) {}

  private records(): Map<string, ChannelRecord> {
    return new Map(this.store.load().map((r) => [r.id, r]));
  }

  list(): ChannelSummary[] {
    return this.store.load().map(summary);
  }

  byId(id: string): ChannelRecord | undefined {
    return this.records().get(id);
  }

  /** Mint a door. The secret is returned here and never listed again. */
  add(opts: { id: string; kind: string; bot: string; paths?: string[] }): ChannelRecord {
    if (!ID_RE.test(opts.id)) {
      throw new ComputerError("VALIDATION", "channel id must be 1-48 chars of a-z 0-9 -");
    }
    if (!KIND_RE.test(opts.kind)) {
      throw new ComputerError("VALIDATION", "channel kind must be 1-32 chars of a-z 0-9 -");
    }
    if (!opts.bot) {
      throw new ComputerError("VALIDATION", "channel needs a bot");
    }
    const records = this.records();
    if (records.has(opts.id)) {
      throw new ComputerError("CONFLICT", `channel ${opts.id} already exists`);
    }
    const record: ChannelRecord = {
      bot: opts.bot,
      created_at: new Date().toISOString(),
      id: opts.id,
      kind: opts.kind,
      paths: opts.paths,
      secret: mintChannelSecret(),
    };
    records.set(record.id, record);
    this.store.save([...records.values()]);
    return record;
  }

  /** New secret, same door. The old one stops working the moment this returns. */
  rotate(id: string): ChannelRecord {
    const records = this.records();
    const existing = records.get(id);
    if (!existing) {
      throw new ComputerError("VALIDATION", `no channel ${id}`);
    }
    const next = { ...existing, secret: mintChannelSecret() };
    records.set(id, next);
    this.store.save([...records.values()]);
    return next;
  }

  remove(id: string): boolean {
    const records = this.records();
    const had = records.delete(id);
    if (had) {
      this.store.save([...records.values()]);
    }
    return had;
  }

  /** Check a presented secret. A missing door and a wrong secret read the same from outside. */
  verify(id: string, secret: string | undefined): ChannelRecord {
    const record = this.byId(id);
    if (!record || !secret || !safeEqual(secret, record.secret)) {
      throw new ComputerError("UNAUTHENTICATED", "bad channel secret");
    }
    return record;
  }
}

function summary(r: ChannelRecord): ChannelSummary {
  const { secret: _secret, ...rest } = r;
  return rest;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}
