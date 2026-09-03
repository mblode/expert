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
import type { Occurrence } from "./state.ts";

/**
 * Conversations: the record the Bot's voice speaks into.
 *
 * Storage is split by shape because the two halves have different ones. The
 * index is a handful of bounded records with the same lifecycle as
 * `connectors.json`, so it gets the `readTokenFile` / `writeTokenFile`
 * discipline from `provision.ts`: atomic rename, and a file that will not
 * read is an error rather than "empty". The log is append-heavy and
 * unbounded, so it is JSONL, one file per conversation, with the same
 * torn-last-line tolerance `BotState.loadTranscript` had.
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

/**
 * How a human on the seat is named in a conversation.
 *
 * The occurrence log never recorded which person was at the keyboard, and a
 * screen is one seat at a time by construction, so there is nothing more
 * specific to import and nothing more specific to invent. A WhatsApp
 * participant carries its JID here; this is the seat's equivalent.
 *
 * Exported with nothing importing it yet because it is a wire value, not an
 * implementation detail: `ConversationParticipant.ref` in `api/computer.proto`
 * documents `"seat"` as the one non-JID `ref`, and `Seat.Conversations` already
 * puts it on the wire. This stays the hub's single named source of it.
 *
 * @public
 */
export const SEAT_HUMAN_REF = "seat";

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
    // Carried through by hand like every other field, and load-bearing: drop
    // it and the one-shot import runs again on the next boot.
    ...(typeof r.imported_from === "string" ? { imported_from: r.imported_from } : {}),
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

/** A `widget` or a `secret_request`: the two bodies that end a turn. */
function isRequest(message: Message | undefined): boolean {
  return message?.body.kind === "widget" || message?.body.kind === "secret_request";
}

/** What an append carries beyond the body: both are optional and both are the hub's. */
interface AppendMeta {
  turn_id?: string;
  /** The id of the request this message closes, see `Message.resolves`. */
  resolves?: string;
}

/**
 * Stateless over its store, like `ConnectorRegistry` and for the same reason:
 * the file is a handful of records and something else may edit it.
 *
 * The two pieces of process state are caches of what the files already say,
 * and both are seeded from disk on first touch so a restart changes nothing.
 * `seqs` caches the next sequence number per conversation so an append does
 * not re-read the log, and it is seeded from `max(index.last_seq, the log's
 * tail)`: the line is written before the index is updated, so a crash
 * between the two leaves the index behind, never ahead, and reading both
 * back is what keeps a cursor meaning what it meant. `turnEnded` is the same
 * rule `VoiceService` used to hold on its own, now held here per
 * conversation, which is why a widget on the seat thread no longer blocks
 * the next WhatsApp reply.
 */
export class ConversationRegistry {
  private readonly seqs = new Map<string, number>();
  private readonly turnEnded = new Map<string, boolean>();

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
   * The Bot's own thread: hello.expert, the phone, the eve TUI, anything
   * that arrives with no turn binding.
   *
   * Idempotent by route, so provisioning can create it eagerly and a Bot
   * re-created under a name it had before adopts the thread it left behind,
   * which is the same promise `ProvisionService.remove` makes about the
   * Bot's directory on the box.
   */
  resolveSeat(bot: string): Conversation {
    return this.resolve(bot, { kind: "seat" }, [
      { bot, kind: "bot" },
      { kind: "human", ref: SEAT_HUMAN_REF },
    ]);
  }

  /**
   * Append one message and return it. The line lands before the index moves,
   * so the log is never behind what a caller was told.
   */
  append(
    conversationId: string,
    author: Author,
    body: MessageBody,
    meta: AppendMeta = {},
  ): Message {
    const record = this.byId(conversationId);
    const seq = this.nextSeq(record);
    const message: Message = {
      at: Date.now(),
      author,
      body,
      conversation_id: record.id,
      id: `occ_${randomBytes(9).toString("base64url")}`,
      seq,
      ...(meta.resolves ? { resolves: meta.resolves } : {}),
      ...(meta.turn_id ? { turn_id: meta.turn_id } : {}),
    };
    this.log.append(message);
    this.seqs.set(record.id, seq);
    this.bumpIndex(record.id, seq);
    if (isRequest(message)) {
      this.turnEnded.set(record.id, true);
    }
    if (body.kind === "human") {
      // A person did something, so the agent may talk again. Same boundary
      // the voice has always drawn.
      this.turnEnded.set(record.id, false);
    }
    return message;
  }

  /**
   * `Agent.SendMessage` into a conversation. The turn rules are the product
   * guarantee, not a prompt request, so they are enforced here rather than
   * asked for in a prompt, and they are enforced in exactly one place so the
   * seat thread and a WhatsApp chat cannot drift apart.
   */
  send(
    conversationId: string,
    author: Author,
    body: MessageBody,
    turnId?: string,
  ): { conversation_id: string; occurrence_id: string; turn_ended: boolean } {
    const record = this.byId(conversationId);
    if (this.ended(record)) {
      throw new ComputerError(
        "CONFLICT",
        "the turn ended, a widget or secret_request is waiting on the human",
      );
    }
    const message = this.append(record.id, author, body, { turn_id: turnId });
    return {
      conversation_id: message.conversation_id,
      occurrence_id: message.id,
      turn_ended: this.ended(record),
    };
  }

  /** The `widget` or `secret_request` waiting on the human, if there is one. */
  pendingRequest(conversationId: string): Message | undefined {
    const record = this.byId(conversationId);
    // An open request is always the tail: closing one appends after it.
    const last = this.log.load(record.id).at(-1);
    return isRequest(last) ? last : undefined;
  }

  /**
   * The open `secret_request`, or the reason it is not one.
   *
   * Two different refusals on purpose. A request that was already provided
   * is `CONFLICT`: replaying it would rewrite the clipboard and re-open the
   * turn behind the agent's back. An id that names nothing is `VALIDATION`.
   */
  requireOpenSecret(conversationId: string, occurrenceId: string): Message {
    const open = this.pendingRequest(conversationId);
    if (open?.id === occurrenceId && open.body.kind === "secret_request") {
      return open;
    }
    const known = this.log.load(this.byId(conversationId).id).find((m) => m.id === occurrenceId);
    if (known?.body.kind === "secret_request") {
      throw new ComputerError("CONFLICT", `secret request ${occurrenceId} was already provided`);
    }
    throw new ComputerError("VALIDATION", `no open secret request ${occurrenceId}`);
  }

  /**
   * The seat answers the open widget. Re-opens the turn and records the
   * choice, which in an append-only log means the answering message names
   * the widget it closes rather than the widget's own line being rewritten.
   *
   * Only the open one, which is stricter than the log the voice used to
   * keep: answering an old widget was a way to re-open a turn that had
   * ended on a newer one.
   */
  answerWidget(conversationId: string, occurrenceId: string, answer: string): Message {
    const open = this.pendingRequest(conversationId);
    if (open?.id !== occurrenceId || open.body.kind !== "widget") {
      throw new ComputerError("VALIDATION", `no open widget ${occurrenceId}`);
    }
    if (!open.body.options.includes(answer)) {
      throw new ComputerError("VALIDATION", "answer must be one of the offered options");
    }
    return this.close(conversationId, occurrenceId, answer);
  }

  /** Append the human message that closes a request. Re-opens the turn. */
  close(conversationId: string, occurrenceId: string, text: string): Message {
    const record = this.byId(conversationId);
    return this.append(
      record.id,
      { kind: "human", ref: SEAT_HUMAN_REF },
      { kind: "human", text },
      { resolves: occurrenceId },
    );
  }

  /**
   * Seed a conversation from the pre-conversations occurrence log, once.
   *
   * `seq` is carried through untouched. That is not cosmetic even with no
   * client reading `Seat.Occurrences` today: a cursor is a promise that a
   * number keeps meaning what it meant, and the first real client will hold
   * one across this deploy.
   *
   * Idempotent twice over, because the only copy of these lines is on two
   * live Fly volumes. The marker on the record stops it being read a second
   * time, and a line whose `seq` the log already holds is skipped anyway, so
   * a crash halfway through resumes instead of duplicating. The source file
   * is never written, here or anywhere else: `ProvisionService.remove`
   * refuses to delete a Bot's box state for the same reason, it is the
   * human's record and not ours to retire.
   */
  importSeatLog(conversationId: string, source: string, entries: Occurrence[]): number {
    const record = this.byId(conversationId);
    if (record.imported_from) {
      return 0;
    }
    let tail = this.nextSeq(record) - 1;
    let written = 0;
    for (const entry of entries) {
      if (!Number.isInteger(entry.seq) || entry.seq <= tail) {
        continue;
      }
      const { at, id, seq, ...body } = entry;
      this.log.append({
        at: typeof at === "number" ? at : Date.now(),
        // The occurrence log recorded no author, so it is derived from the
        // kind, which is what it always meant: `human` is the person at the
        // seat and everything else is the Bot's own voice.
        author:
          body.kind === "human"
            ? { kind: "human", ref: SEAT_HUMAN_REF }
            : { bot: record.bot, kind: "bot" },
        body: body as MessageBody,
        conversation_id: record.id,
        id,
        seq,
      });
      tail = seq;
      written++;
    }
    this.seqs.set(record.id, tail);
    this.turnEnded.delete(record.id);
    this.markImported(record.id, source, tail);
    return written;
  }

  /** Cursor page, oldest first. `cursor` is the last seq the caller has. */
  page(conversationId: string, cursor?: string, limit = 100): ConversationPage {
    const record = this.byId(conversationId);
    const after = cursor ? Number(cursor) : 0;
    if (cursor && !Number.isFinite(after)) {
      throw new ComputerError("VALIDATION", "cursor must be a sequence number");
    }
    const n = Math.min(Math.max(limit, 1), 500);
    const all = this.log.load(record.id);
    // Built over the whole log, not the page: the message that answers a
    // widget can sit past the window the caller asked for.
    const closed = resolutions(all);
    const rest = all.filter((m) => m.seq > after);
    const entries = rest.slice(0, n);
    const more = rest.length > entries.length;
    return {
      entries: entries.map((m) => flatten(m, closed)),
      next_cursor: more && entries.length ? String(entries.at(-1)!.seq) : null,
    };
  }

  /** Is this conversation waiting on the human? Seeded from the log on first ask. */
  private ended(record: Conversation): boolean {
    const cached = this.turnEnded.get(record.id);
    if (cached !== undefined) {
      return cached;
    }
    // A turn that ended before the restart is still ended: the human is
    // being waited on, and the agent does not get a free send by crashing.
    const seeded = isRequest(this.log.load(record.id).at(-1));
    this.turnEnded.set(record.id, seeded);
    return seeded;
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
    this.patch(id, (record) => ({ ...record, last_seq: seq }));
  }

  private markImported(id: string, source: string, seq: number): void {
    this.patch(id, (record) => ({
      ...record,
      imported_from: source,
      last_seq: Math.max(record.last_seq, seq),
    }));
  }

  private patch(id: string, change: (record: Conversation) => Conversation): void {
    const records = this.store.load();
    const i = records.findIndex((c) => c.id === id);
    if (i === -1) {
      return;
    }
    records[i] = { ...change(records[i]!), updated_at: new Date().toISOString() };
    this.store.save(records);
  }
}

/**
 * Which requests have been closed, and with what.
 *
 * A widget's `answer` and a secret_request's `provided` are resolution state
 * over an append-only log, so they are derived on read from the message that
 * closed them rather than stored on a line that would have to be rewritten.
 * Deriving them from "a human spoke next" instead would be wrong: a person
 * typing something unrelated after a widget re-opens the turn without
 * answering it.
 */
function resolutions(messages: Message[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.resolves && m.body.kind === "human") {
      out.set(m.resolves, m.body.text);
    }
  }
  return out;
}

function flatten(m: Message, closed: Map<string, string>): ConversationEntry {
  const body =
    m.body.kind === "widget"
      ? { ...m.body, answer: closed.get(m.id) ?? m.body.answer }
      : m.body.kind === "secret_request"
        ? { ...m.body, provided: closed.has(m.id) || m.body.provided }
        : m.body;
  return {
    ...body,
    at: m.at,
    author: m.author,
    conversation_id: m.conversation_id,
    id: m.id,
    seq: m.seq,
    ...(m.turn_id ? { turn_id: m.turn_id } : {}),
  };
}
