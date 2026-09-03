import { randomBytes } from "node:crypto";
import { ComputerError, MAX_WIDGET_OPTIONS } from "@computer/shared";
import type { MessageBody, OccurrenceKind } from "@computer/shared";
import type { Desk } from "../desk/types.ts";

/**
 * The voice.
 *
 * Plain model text is a private scratchpad. The human sees exactly the
 * occurrences in this log and nothing else, so a turn that ends without a
 * send is silence, which is legal for a routine and a bug for a person.
 *
 * Two rules are enforced here rather than asked for in a prompt, because a
 * prompt is a request and this is the product guarantee:
 *
 *   1. `widget` and `secret_request` END the turn. Stop and wait.
 *   2. A second send after the turn ended is rejected.
 *
 * A turn re-opens when the human speaks again, a message, a widget answer,
 * or a delivered secret. That is the same boundary in all three cases: the
 * person did something, so the agent may talk again.
 */

export type Occurrence =
  | { id: string; seq: number; at: number; kind: "human"; text: string }
  | { id: string; seq: number; at: number; kind: "text"; text: string; images: string[] }
  | {
      id: string;
      seq: number;
      at: number;
      kind: "widget";
      prompt: string;
      options: string[];
      answer: string | null;
    }
  | {
      id: string;
      seq: number;
      at: number;
      kind: "secret_request";
      prompt: string;
      label: string;
      provided: boolean;
    };

/** Distributive omit, a plain Omit over a union keeps only common keys. */
type Draft<T> = T extends unknown ? Omit<T, "id" | "seq" | "at"> : never;

export type SendBody =
  | { kind: "text"; text: string; images?: string[] }
  | { kind: "widget"; prompt: string; options: string[] }
  | { kind: "secret_request"; prompt: string; label: string };

export interface Page {
  entries: Occurrence[];
  next_cursor: string | null;
}

/**
 * Where the log outlives the hub process. Implemented by the Bot's directory
 * on the box (`BotState`); absent in the unit tests that only care about turn
 * rules. Writing is never on the caller's path, see `persist`.
 */
export interface TranscriptStore {
  appendOccurrence(o: Occurrence): Promise<void>;
}

/** Cap the retained log. The box is a pet, not a database. */
const MAX_LOG = 2000;

/**
 * How long a delivered secret may sit on the clipboard.
 *
 * The clipboard is per display, but the box is one trust domain: everything
 * on that screen can read it for as long as it is there. Clearing at once
 * would be safest and useless: the agent still has to wake, look, click and
 * paste, and that is a model turn or three. Two minutes is generous enough
 * that a normal paste never races the clear, and short enough that a
 * password the human typed once is not still readable an hour later.
 */
const SECRET_TTL_MS = 120_000;

export class VoiceService {
  private readonly log: Occurrence[] = [];
  private seq = 0;
  private turnEnded = false;
  /** Set while a secret_request is outstanding, so the value has a home. */
  private pendingSecret: string | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serialises the write-behind appends so the file keeps the log's order. */
  private writes: Promise<void> = Promise.resolve();
  /** Persistence starts only once the previous run has been read back in. */
  private restored = false;

  /** `secretTtlMs` is injectable so tests do not wait out the real window. */
  constructor(
    private readonly desk: Desk,
    private readonly secretTtlMs: number = SECRET_TTL_MS,
    private readonly transcript?: TranscriptStore,
  ) {}

  /**
   * Load the previous run's log, once, at boot, and only then start writing.
   *
   * Both halves matter. `seq` continues from what was restored, so a cursor
   * the phone held across a restart still means what it meant. And a hub that
   * failed to read the transcript must not append to it: numbering a second
   * run's occurrences from 1 into the same file is how you get two entries
   * claiming seq 4.
   */
  restore(entries: Occurrence[]): void {
    if (this.restored) {
      return;
    }
    this.restored = true;
    this.log.push(...entries.slice(-MAX_LOG));
    this.seq = this.log.at(-1)?.seq ?? 0;
    // A turn that ended before the restart is still ended: the human is being
    // waited on, and the agent does not get a free send by crashing.
    const last = this.log.at(-1);
    if (last?.kind === "widget" && last.answer === null) {
      this.turnEnded = true;
    }
    if (last?.kind === "secret_request" && !last.provided) {
      this.turnEnded = true;
      this.pendingSecret = last.id;
    }
  }

  /** Agent.SendMessage. Returns the occurrence id and whether the turn ended. */
  async send(body: SendBody): Promise<{ occurrence_id: string; turn_ended: boolean }> {
    if (this.turnEnded) {
      throw new ComputerError(
        "CONFLICT",
        "the turn ended, a widget or secret_request is waiting on the human",
      );
    }
    const o = this.append(buildBody(body));
    if (o.kind === "widget" || o.kind === "secret_request") {
      this.turnEnded = true;
      if (o.kind === "secret_request") {
        this.pendingSecret = o.id;
      }
    }
    return { occurrence_id: o.id, turn_ended: this.turnEnded };
  }

  /** A person said something. Re-opens the turn. */
  sayHuman(text: string): Occurrence {
    const o = this.append({ kind: "human", text });
    this.turnEnded = false;
    return o;
  }

  /** Seat answers a widget. Re-opens the turn and records the choice. */
  answerWidget(occurrenceId: string, answer: string): Occurrence {
    const w = this.log.find((o) => o.id === occurrenceId && o.kind === "widget");
    if (!w || w.kind !== "widget") {
      throw new ComputerError("VALIDATION", `no open widget ${occurrenceId}`);
    }
    if (!w.options.includes(answer)) {
      throw new ComputerError("VALIDATION", "answer must be one of the offered options");
    }
    w.answer = answer;
    return this.sayHuman(answer);
  }

  /**
   * Seat delivers a secret.
   *
   * The value goes to the box clipboard and nowhere else: not the log, not
   * the response, not the model's context. The agent learns only that it
   * was provided, and pastes it. Anything that returns the value from here
   * has defeated the point of the masked field.
   *
   * The clipboard is a loan, not a home, see `scheduleClear`.
   */
  async provideSecret(occurrenceId: string, value: string): Promise<Occurrence> {
    const s = this.log.find((o) => o.id === occurrenceId && o.kind === "secret_request");
    if (!s || s.kind !== "secret_request") {
      throw new ComputerError("VALIDATION", `no open secret request ${occurrenceId}`);
    }
    // Once. A delivered request cannot be replayed to rewrite the clipboard
    // and re-open the turn behind the agent's back.
    if (s.provided) {
      throw new ComputerError("CONFLICT", `secret request ${occurrenceId} was already provided`);
    }
    if (!value) {
      throw new ComputerError("VALIDATION", "secret value is required");
    }
    await this.desk.clipboardSet(value);
    this.scheduleClear(value);
    s.provided = true;
    this.pendingSecret = null;
    return this.sayHuman(`${s.label} is on the clipboard, paste it.`);
  }

  /**
   * Take the secret back off the clipboard once the paste window has passed.
   *
   * Compare-and-clear: only wipe it if the clipboard still holds what we put
   * there. Anything else means someone copied over it: the agent, the human,
   * or `type()`, which routes unicode through the clipboard, and that data is
   * not ours to destroy. `value` lives only in this closure: it is never
   * logged, returned, or put in an error, including when the desk is dead.
   */
  private scheduleClear(value: string): void {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
    }
    this.clearTimer = setTimeout(() => {
      this.clearTimer = null;
      void this.desk
        .clipboardGet()
        .then((held) => (held === value ? this.desk.clipboardSet("") : undefined))
        .catch(() => {});
    }, this.secretTtlMs);
    // A pending clear is not a reason to keep the hub alive.
    this.clearTimer.unref();
  }

  /** True while a secret is staged on the clipboard and not yet consumed. */
  secretPending(): boolean {
    return this.pendingSecret !== null;
  }

  /** Cursor page, oldest first. `cursor` is the last seq the caller has. */
  page(cursor?: string, limit = 100): Page {
    const after = cursor ? Number(cursor) : 0;
    if (cursor && !Number.isFinite(after)) {
      throw new ComputerError("VALIDATION", "cursor must be a sequence number");
    }
    const n = Math.min(Math.max(limit, 1), 500);
    const rest = this.log.filter((o) => o.seq > after);
    const entries = rest.slice(0, n);
    const more = rest.length > entries.length;
    return {
      entries,
      next_cursor: more && entries.length ? String(entries.at(-1)!.seq) : null,
    };
  }

  /**
   * Write-behind, in order, best effort.
   *
   * A bubble is not held up by a `docker exec`, and a box that cannot be
   * written to costs the tail of the transcript rather than the voice itself:
   * the human still sees what the agent said, which is the guarantee that
   * matters. `sayHuman` and `answerWidget` are synchronous callers, so this
   * cannot be awaited here even if we wanted to.
   */
  private persist(o: Occurrence): void {
    if (!this.transcript || !this.restored) {
      return;
    }
    this.writes = this.writes
      .then(() => this.transcript!.appendOccurrence(o))
      .catch((error: unknown) => {
        console.warn(`transcript: ${(error as Error).message}`);
      });
  }

  /** Settle the write-behind queue: shutdown, and tests that read the file back. */
  flushed(): Promise<void> {
    return this.writes;
  }

  /** Test helper. */
  reset(): void {
    this.log.length = 0;
    this.seq = 0;
    this.turnEnded = false;
    this.pendingSecret = null;
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
    }
    this.clearTimer = null;
  }

  private append(partial: Draft<Occurrence>): Occurrence {
    const o = {
      ...partial,
      at: Date.now(),
      id: `occ_${randomBytes(9).toString("base64url")}`,
      seq: ++this.seq,
    } as Occurrence;
    this.log.push(o);
    if (this.log.length > MAX_LOG) {
      this.log.splice(0, this.log.length - MAX_LOG);
    }
    this.persist(o);
    return o;
  }
}

/**
 * Validate a send and normalise it into the stored body.
 *
 * Module-level rather than a method because both logs need it: the seat
 * thread through `VoiceService.send`, and a conversation through
 * `ConversationRegistry.send`. The rules are the wire contract, so there is
 * one copy of them and the two paths cannot drift.
 */
export function buildBody(body: SendBody): MessageBody {
  switch (body.kind) {
    case "text": {
      if (!body.text) {
        throw new ComputerError("VALIDATION", "text is required");
      }
      return { images: body.images ?? [], kind: "text", text: body.text };
    }
    case "widget": {
      if (!body.prompt) {
        throw new ComputerError("VALIDATION", "widget prompt is required");
      }
      const options = body.options ?? [];
      if (options.length < 1 || options.length > MAX_WIDGET_OPTIONS) {
        throw new ComputerError("VALIDATION", `widget needs 1..${MAX_WIDGET_OPTIONS} options`);
      }
      if (options.some((o) => !o)) {
        throw new ComputerError("VALIDATION", "widget options must be non-empty");
      }
      return { answer: null, kind: "widget", options, prompt: body.prompt };
    }
    case "secret_request": {
      if (!body.prompt) {
        throw new ComputerError("VALIDATION", "secret prompt is required");
      }
      if (!body.label) {
        throw new ComputerError("VALIDATION", "secret label is required");
      }
      return { kind: "secret_request", label: body.label, prompt: body.prompt, provided: false };
    }
  }
}

/** Parse the JSON wire body of Agent.SendMessage into a SendBody. */
export function parseSendBody(body: unknown): SendBody {
  if (!body || typeof body !== "object") {
    throw new ComputerError("VALIDATION", "send_message body must be an object");
  }
  const o = body as Record<string, unknown>;
  const kind = o.kind as OccurrenceKind | undefined;
  switch (kind) {
    case "text": {
      return {
        kind: "text",
        text: String(o.text ?? ""),
        images: Array.isArray(o.images) ? (o.images as string[]).map(String) : undefined,
      };
    }
    case "widget": {
      return {
        kind: "widget",
        prompt: String(o.prompt ?? ""),
        options: Array.isArray(o.options) ? (o.options as unknown[]).map(String) : [],
      };
    }
    case "secret_request": {
      return {
        kind: "secret_request",
        prompt: String(o.prompt ?? ""),
        label: String(o.label ?? ""),
      };
    }
    default: {
      throw new ComputerError("VALIDATION", "kind must be text, widget or secret_request");
    }
  }
}
