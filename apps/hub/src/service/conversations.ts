import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONVERSATION_ROUTE_KINDS, ComputerError } from "@computer/shared";
import type {
  Author,
  Conversation,
  ConversationRouteKind,
  Message,
  MessageBody,
  Participant,
  Route,
} from "@computer/shared";
import { readTokenFile, writeTokenFile } from "./provision.ts";

/**
 * Conversations: the record the Bot's voice speaks into.
 *
 * Storage is split by shape because the two halves have different ones. The
 * index is a handful of bounded records with the same lifecycle as
 * `channels.json`, so it gets the `readTokenFile` / `writeTokenFile`
 * discipline from `provision.ts`: atomic rename, and a file that will not
 * read is an error rather than "empty". The log is append-heavy and
 * unbounded, so it is JSONL, one file per conversation, with the same
 * torn-last-line tolerance `BotState.loadTranscript` has.
 *
 * Both live under the hub's own directory, not `/workspace/.bots`. That is
 * the point of moving them: the model runs as `box` and cannot read or
 * rewrite what is about to become an audit trail (AUDIT.md P1 #9).
 */

/** Flatten a `Message` for the read view: `Seat.Occurrences` has always been flat. */
type Flatten<T> = T extends unknown
  ? T & {
      id: string;
      seq: number;
      at: number;
      conversation_id: string;
      author: Author;
      turn_id?: string;
    }
  : never;

/**
 * One entry as `Seat.Occurrences` returns it: today's flat occurrence plus
 * `conversation_id` and `author`. The stored `Message` nests its body; the
 * wire does not, because a second entry shape for the same RPC would be a
 * second contract for no reader.
 */
export type ConversationEntry = Flatten<MessageBody>;

export interface ConversationPage {
  entries: ConversationEntry[];
  next_cursor: string | null;
}

export interface ConversationStore {
  load(): Conversation[];
  save(records: Conversation[]): void;
}

export class MemoryConversationStore implements ConversationStore {
  private records: Conversation[] = [];

  load(): Conversation[] {
    return this.records;
  }

  save(records: Conversation[]): void {
    this.records = records;
  }
}

/** `conversations.json` beside the roster: same 0600 file, same reason. */
export class FileConversationStore implements ConversationStore {
  constructor(private readonly path: string) {}

  load(): Conversation[] {
    const parsed = readTokenFile(this.path, "conversations");
    if (parsed === undefined) {
      return [];
    }
    return parsed.map((entry) => conversationFrom(entry, this.path));
  }

  save(records: Conversation[]): void {
    writeTokenFile(this.path, records);
  }
}

/** The append-only half. One file per conversation, oldest line first. */
export interface MessageLog {
  append(message: Message): void;
  load(conversationId: string): Message[];
}

export class MemoryMessageLog implements MessageLog {
  private readonly lines = new Map<string, string[]>();

  append(message: Message): void {
    const existing = this.lines.get(message.conversation_id) ?? [];
    existing.push(JSON.stringify(message));
    this.lines.set(message.conversation_id, existing);
  }

  load(conversationId: string): Message[] {
    return parseLog((this.lines.get(conversationId) ?? []).join("\n"));
  }
}

/**
 * JSONL under `<dir>/<conversation id>.jsonl`, 0600 in a 0700 directory.
 *
 * The append is synchronous on purpose. A line is a few hundred bytes, and
 * `seq` is allocated from the tail of this file: an async write-behind would
 * let two appends race for the same number, which is the one thing a cursor
 * contract cannot survive. `writeTokenFile` already writes the roster this
 * way for the same reason.
 */
export class FileMessageLog implements MessageLog {
  constructor(private readonly dir: string) {}

  append(message: Message): void {
    mkdirSync(this.dir, { mode: 0o700, recursive: true });
    appendFileSync(this.pathFor(message.conversation_id), `${JSON.stringify(message)}\n`, {
      mode: 0o600,
    });
  }

  load(conversationId: string): Message[] {
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(conversationId), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return parseLog(raw);
  }

  private pathFor(conversationId: string): string {
    // Ids are minted here and validated on read, so this can never traverse.
    if (!ID_RE.test(conversationId)) {
      throw new ComputerError("VALIDATION", `bad conversation id ${conversationId}`);
    }
    return join(this.dir, `${conversationId}.jsonl`);
  }
}

/**
 * A torn last line is the normal shape of a crash mid-append. Skip it rather
 * than throwing away every message that came before it.
 */
function parseLog(raw: string): Message[] {
  const out: Message[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line) as Message);
    } catch {
      // Deliberately silent: see above.
    }
  }
  return out;
}

const ID_RE = /^conv_[A-Za-z0-9_-]{1,64}$/;

function conversationFrom(entry: unknown, path: string): Conversation {
  if (!entry || typeof entry !== "object") {
    throw new Error(`conversations ${path} must be a JSON array of conversation records`);
  }
  const r = entry as Partial<Conversation>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) {
    throw new Error(`conversations ${path}: a record has a bad id`);
  }
  if (typeof r.bot !== "string" || !r.bot) {
    throw new Error(`conversations ${path}: conversation ${r.id} has no bot`);
  }
  const kind = (r.route as { kind?: string } | undefined)?.kind;
  if (!CONVERSATION_ROUTE_KINDS.includes(kind as ConversationRouteKind)) {
    throw new Error(`conversations ${path}: conversation ${r.id} has an unknown route kind`);
  }
  return {
    bot: r.bot,
    created_at: typeof r.created_at === "string" ? r.created_at : "1970-01-01T00:00:00.000Z",
    id: r.id,
    last_seq: typeof r.last_seq === "number" ? r.last_seq : 0,
    participants: Array.isArray(r.participants) ? (r.participants as Participant[]) : [],
    route: r.route as Route,
    updated_at: typeof r.updated_at === "string" ? r.updated_at : "1970-01-01T00:00:00.000Z",
  };
}

/** Two routes are the same conversation when every field of the route matches. */
function sameRoute(a: Route, b: Route): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "whatsapp" && b.kind === "whatsapp") {
    return a.acct === b.acct && a.jid === b.jid;
  }
  if (a.kind === "peer" && b.kind === "peer") {
    return a.bot === b.bot;
  }
  return true;
}

/**
 * Stateless over its store, like `ChannelRegistry` and for the same reason:
 * the file is a handful of records and something else may edit it.
 *
 * The two pieces of process state are deliberate. `seqs` caches the next
 * sequence number per conversation so an append does not re-read the log,
 * and it is seeded from `max(index.last_seq, the log's tail)`: the line is
 * written before the index is updated, so a crash between the two leaves the
 * index behind, never ahead, and reading both back is what keeps a cursor
 * meaning what it meant. `turnEnded` is the same rule `VoiceService` has
 * always enforced, held per conversation rather than per Bot, which is why a
 * widget on the seat thread no longer blocks the next WhatsApp reply.
 */
export class ConversationRegistry {
  private readonly seqs = new Map<string, number>();
  private readonly turnEnded = new Set<string>();

  constructor(
    private readonly store: ConversationStore = new MemoryConversationStore(),
    private readonly log: MessageLog = new MemoryMessageLog(),
  ) {}

  list(): Conversation[] {
    return this.store.load();
  }

  byId(id: string): Conversation {
    const found = this.store.load().find((c) => c.id === id);
    if (!found) {
      throw new ComputerError("VALIDATION", `no conversation ${id}`);
    }
    return found;
  }

  /**
   * The conversation for a route, created on first sight.
   *
   * `participants` is only used when the record is created: an existing
   * conversation is never rewritten from an inbound message, because the
   * inbound names one sender and a group has many, and the record is the
   * hub's, not the transport's.
   */
  resolve(bot: string, route: Route, participants: Participant[]): Conversation {
    const records = this.store.load();
    const existing = records.find((c) => c.bot === bot && sameRoute(c.route, route));
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const record: Conversation = {
      bot,
      created_at: now,
      id: `conv_${randomBytes(9).toString("base64url")}`,
      last_seq: 0,
      participants,
      route,
      updated_at: now,
    };
    this.store.save([...records, record]);
    return record;
  }

  /**
   * Append one message and return it. The line lands before the index moves,
   * so the log is never behind what a caller was told.
   */
  append(conversationId: string, author: Author, body: MessageBody, turnId?: string): Message {
    const record = this.byId(conversationId);
    const seq = this.nextSeq(record);
    const message: Message = {
      at: Date.now(),
      author,
      body,
      conversation_id: record.id,
      id: `occ_${randomBytes(9).toString("base64url")}`,
      seq,
      ...(turnId ? { turn_id: turnId } : {}),
    };
    this.log.append(message);
    this.seqs.set(record.id, seq);
    this.bumpIndex(record.id, seq);
    if (body.kind === "widget" || body.kind === "secret_request") {
      this.turnEnded.add(record.id);
    }
    if (body.kind === "human") {
      // A person did something, so the agent may talk again. Same boundary
      // `VoiceService.sayHuman` has always drawn.
      this.turnEnded.delete(record.id);
    }
    return message;
  }

  /**
   * `Agent.SendMessage` into a conversation. The turn rules are the product
   * guarantee, not a prompt request, so they are enforced here exactly as
   * `VoiceService.send` enforces them for the seat thread.
   */
  send(
    conversationId: string,
    author: Author,
    body: MessageBody,
    turnId?: string,
  ): { conversation_id: string; occurrence_id: string; turn_ended: boolean } {
    if (this.turnEnded.has(conversationId)) {
      throw new ComputerError(
        "CONFLICT",
        "the turn ended, a widget or secret_request is waiting on the human",
      );
    }
    const message = this.append(conversationId, author, body, turnId);
    return {
      conversation_id: message.conversation_id,
      occurrence_id: message.id,
      turn_ended: this.turnEnded.has(conversationId),
    };
  }

  /** Cursor page, oldest first. `cursor` is the last seq the caller has. */
  page(conversationId: string, cursor?: string, limit = 100): ConversationPage {
    const record = this.byId(conversationId);
    const after = cursor ? Number(cursor) : 0;
    if (cursor && !Number.isFinite(after)) {
      throw new ComputerError("VALIDATION", "cursor must be a sequence number");
    }
    const n = Math.min(Math.max(limit, 1), 500);
    const rest = this.log.load(record.id).filter((m) => m.seq > after);
    const entries = rest.slice(0, n);
    const more = rest.length > entries.length;
    return {
      entries: entries.map(flatten),
      next_cursor: more && entries.length ? String(entries.at(-1)!.seq) : null,
    };
  }

  private nextSeq(record: Conversation): number {
    const cached = this.seqs.get(record.id);
    if (cached !== undefined) {
      return cached + 1;
    }
    const tail = this.log.load(record.id).at(-1)?.seq ?? 0;
    return Math.max(record.last_seq, tail) + 1;
  }

  private bumpIndex(id: string, seq: number): void {
    const records = this.store.load();
    const i = records.findIndex((c) => c.id === id);
    if (i === -1) {
      return;
    }
    records[i] = { ...records[i]!, last_seq: seq, updated_at: new Date().toISOString() };
    this.store.save(records);
  }
}

function flatten(m: Message): ConversationEntry {
  return {
    ...m.body,
    at: m.at,
    author: m.author,
    conversation_id: m.conversation_id,
    id: m.id,
    seq: m.seq,
    ...(m.turn_id ? { turn_id: m.turn_id } : {}),
  };
}
