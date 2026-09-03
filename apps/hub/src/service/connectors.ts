import { randomBytes, timingSafeEqual } from "node:crypto";
import { ComputerError } from "@computer/shared";
import { readTokenFile, writeTokenFile } from "./provision.ts";

/**
 * Connectors: the doors through which something other than a seat reaches a
 * Bot's Eve. The WhatsApp bridge on this Machine, a webhook, a Slack app.
 * Each one is a record here with its own secret, so a connector is revoked or
 * rotated on its own and never borrows a seat token (which is a human's and
 * owns the box) or the hub→Eve secret (which is loopback plumbing).
 *
 * A connector points inward and carries a credential this hub minted. That is
 * the whole difference from a plugin, which points outward at a remote MCP or
 * OpenAPI service and carries a credential a human consented to hand over.
 * Naming them apart is the reason this file stopped saying "channel": a
 * channel is a way messages reach a Bot (`apps/eve/lib/channels/*`), a
 * connector is the credential that opens the door in front of one.
 *
 * The ingress (`handler/connectors.ts`) maps `/connectors/<id>/<rest>` onto
 * the Bot's Eve at `/eve/v1/<kind>/<rest>`: the id picks the record and the
 * Bot, the kind picks the Eve channel file. `paths`, when set, narrows which
 * Eve routes this door may reach.
 */
export interface ConnectorRecord {
  id: string;
  /** The Eve channel kind, e.g. `whatsapp`: the route prefix under /eve/v1. */
  kind: string;
  bot: string;
  secret: string;
  paths?: string[];
  created_at: string;
}

/** What a list may show: everything but the secret. */
export type ConnectorSummary = Omit<ConnectorRecord, "secret">;

export interface ConnectorStore {
  load(): ConnectorRecord[];
  save(records: ConnectorRecord[]): void;
}

export class MemoryConnectorStore implements ConnectorStore {
  private records: ConnectorRecord[] = [];

  load(): ConnectorRecord[] {
    return this.records;
  }

  save(records: ConnectorRecord[]): void {
    this.records = records;
  }
}

/**
 * `connectors.json` beside the roster: same 0600 file discipline, same reason.
 *
 * `legacyPath` is the pre-rename `channels.json`, which is what is actually
 * sitting on both deployed Fly volumes. Read falls back to it so a hub that
 * deploys onto an unmigrated volume still finds the tenant's WhatsApp secret;
 * without that the door would authenticate nobody and WhatsApp would stay
 * down until someone re-provisioned the number by hand. Write always goes to
 * the new name, so the first mutation migrates the content forward and the
 * old file stays put as a rollback artifact. Nothing deletes it here: a
 * destructive step on deploy is the one thing this fallback exists to avoid.
 * Drop `legacyPath` once both tenants have written a `connectors.json`.
 */
export class FileConnectorStore implements ConnectorStore {
  constructor(
    private readonly path: string,
    private readonly legacyPath?: string,
  ) {}

  load(): ConnectorRecord[] {
    const current = readTokenFile(this.path, "connectors");
    if (current !== undefined) {
      return current.map((entry) => connectorRecordFrom(entry, this.path));
    }
    const legacy = this.legacyPath;
    if (legacy === undefined) {
      return [];
    }
    const parsed = readTokenFile(legacy, "connectors");
    return parsed === undefined ? [] : parsed.map((entry) => connectorRecordFrom(entry, legacy));
  }

  save(records: ConnectorRecord[]): void {
    writeTokenFile(this.path, records);
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const KIND_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function connectorRecordFrom(entry: unknown, path: string): ConnectorRecord {
  if (!entry || typeof entry !== "object") {
    throw new Error(`connectors ${path} must be a JSON array of connector records`);
  }
  const r = entry as Partial<ConnectorRecord>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) {
    throw new Error(`connectors ${path}: a record has a bad id`);
  }
  if (typeof r.kind !== "string" || !KIND_RE.test(r.kind)) {
    throw new Error(`connectors ${path}: connector ${r.id} has a bad kind`);
  }
  if (typeof r.bot !== "string" || !r.bot) {
    throw new Error(`connectors ${path}: connector ${r.id} has no bot`);
  }
  if (typeof r.secret !== "string" || !r.secret) {
    throw new Error(`connectors ${path}: connector ${r.id} has no secret`);
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

export function mintConnectorSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Stateless over its store on purpose: `npm run bot -- connector add` edits
 * `connectors.json` behind a running hub, and a registry that cached the file
 * at boot would neither see that door nor keep it on its next write. The
 * file is a handful of records, so reading it per call costs nothing.
 *
 * No lockout here, unlike `Pair`. The ingress is public and a connector id is
 * guessable (`whatsapp-<acct>`), so a per-id lockout would let anyone on the
 * internet block the real bridge for a minute at a time with ten junk
 * requests. A 256-bit secret is not an online-guessing target; the
 * constant-time compare is the whole defence.
 */
export class ConnectorRegistry {
  constructor(private readonly store: ConnectorStore = new MemoryConnectorStore()) {}

  private records(): Map<string, ConnectorRecord> {
    return new Map(this.store.load().map((r) => [r.id, r]));
  }

  list(): ConnectorSummary[] {
    return this.store.load().map(summary);
  }

  byId(id: string): ConnectorRecord | undefined {
    return this.records().get(id);
  }

  /** Mint a door. The secret is returned here and never listed again. */
  add(opts: { id: string; kind: string; bot: string; paths?: string[] }): ConnectorRecord {
    if (!ID_RE.test(opts.id)) {
      throw new ComputerError("VALIDATION", "connector id must be 1-48 chars of a-z 0-9 -");
    }
    if (!KIND_RE.test(opts.kind)) {
      throw new ComputerError("VALIDATION", "connector kind must be 1-32 chars of a-z 0-9 -");
    }
    if (!opts.bot) {
      throw new ComputerError("VALIDATION", "connector needs a bot");
    }
    const records = this.records();
    if (records.has(opts.id)) {
      throw new ComputerError("CONFLICT", `connector ${opts.id} already exists`);
    }
    const record: ConnectorRecord = {
      bot: opts.bot,
      created_at: new Date().toISOString(),
      id: opts.id,
      kind: opts.kind,
      paths: opts.paths,
      secret: mintConnectorSecret(),
    };
    records.set(record.id, record);
    this.store.save([...records.values()]);
    return record;
  }

  /** New secret, same door. The old one stops working the moment this returns. */
  rotate(id: string): ConnectorRecord {
    const records = this.records();
    const existing = records.get(id);
    if (!existing) {
      throw new ComputerError("VALIDATION", `no connector ${id}`);
    }
    const next = { ...existing, secret: mintConnectorSecret() };
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
  verify(id: string, secret: string | undefined): ConnectorRecord {
    const record = this.byId(id);
    if (!record || !secret || !safeEqual(secret, record.secret)) {
      throw new ComputerError("UNAUTHENTICATED", "bad connector secret");
    }
    return record;
  }
}

function summary(r: ConnectorRecord): ConnectorSummary {
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
