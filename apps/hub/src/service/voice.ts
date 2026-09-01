import { randomBytes } from "node:crypto";
import { ComputerError, MAX_WIDGET_OPTIONS, type OccurrenceKind } from "@computer/shared";
import type { Desk } from "../desk/types.ts";

/**
 * The voice.
 *
 * Plain model text is a private scratchpad. The human sees exactly the
 * occurrences in this log and nothing else, so a turn that ends without a
 * send is silence — which is legal for a routine and a bug for a person.
 *
 * Two rules are enforced here rather than asked for in a prompt, because a
 * prompt is a request and this is the product guarantee:
 *
 *   1. `widget` and `secret_request` END the turn. Stop and wait.
 *   2. A second send after the turn ended is rejected.
 *
 * A turn re-opens when the human speaks again — a message, a widget answer,
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

/** Distributive omit — a plain Omit over a union keeps only common keys. */
type Draft<T> = T extends unknown ? Omit<T, "id" | "seq" | "at"> : never;

export type SendBody =
  | { kind: "text"; text: string; images?: string[] }
  | { kind: "widget"; prompt: string; options: string[] }
  | { kind: "secret_request"; prompt: string; label: string };

export type Page = { entries: Occurrence[]; next_cursor: string | null };

/** Cap the retained log. The box is a pet, not a database. */
const MAX_LOG = 2000;

export class VoiceService {
  private readonly log: Occurrence[] = [];
  private seq = 0;
  private turnEnded = false;
  /** Set while a secret_request is outstanding, so the value has a home. */
  private pendingSecret: string | null = null;
  private readonly listeners = new Set<(o: Occurrence) => void>();

  constructor(private readonly desk: Desk) {}

  /** Agent.SendMessage. Returns the occurrence id and whether the turn ended. */
  async send(body: SendBody): Promise<{ occurrence_id: string; turn_ended: boolean }> {
    if (this.turnEnded) {
      throw new ComputerError(
        "CONFLICT",
        "the turn ended — a widget or secret_request is waiting on the human",
      );
    }
    const o = this.append(this.build(body));
    if (o.kind === "widget" || o.kind === "secret_request") {
      this.turnEnded = true;
      if (o.kind === "secret_request") this.pendingSecret = o.id;
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
   */
  async provideSecret(occurrenceId: string, value: string): Promise<Occurrence> {
    const s = this.log.find((o) => o.id === occurrenceId && o.kind === "secret_request");
    if (!s || s.kind !== "secret_request") {
      throw new ComputerError("VALIDATION", `no open secret request ${occurrenceId}`);
    }
    if (!value) throw new ComputerError("VALIDATION", "secret value is required");
    await this.desk.clipboardSet(value);
    s.provided = true;
    this.pendingSecret = null;
    return this.sayHuman(`${s.label} is on the clipboard — paste it.`);
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
      next_cursor: more && entries.length ? String(entries[entries.length - 1]!.seq) : null,
    };
  }

  /** Live tail for the SSE chat stream. */
  subscribe(fn: (o: Occurrence) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Test helper. */
  reset(): void {
    this.log.length = 0;
    this.seq = 0;
    this.turnEnded = false;
    this.pendingSecret = null;
  }

  private build(body: SendBody): Draft<Occurrence> {
    switch (body.kind) {
      case "text": {
        if (!body.text) throw new ComputerError("VALIDATION", "text is required");
        return { kind: "text", text: body.text, images: body.images ?? [] };
      }
      case "widget": {
        if (!body.prompt) throw new ComputerError("VALIDATION", "widget prompt is required");
        const options = body.options ?? [];
        if (options.length < 1 || options.length > MAX_WIDGET_OPTIONS) {
          throw new ComputerError("VALIDATION", `widget needs 1..${MAX_WIDGET_OPTIONS} options`);
        }
        if (options.some((o) => !o)) {
          throw new ComputerError("VALIDATION", "widget options must be non-empty");
        }
        return { kind: "widget", prompt: body.prompt, options, answer: null };
      }
      case "secret_request": {
        if (!body.prompt) throw new ComputerError("VALIDATION", "secret prompt is required");
        if (!body.label) throw new ComputerError("VALIDATION", "secret label is required");
        return { kind: "secret_request", prompt: body.prompt, label: body.label, provided: false };
      }
    }
  }

  private append(partial: Draft<Occurrence>): Occurrence {
    const o = {
      ...partial,
      id: `occ_${randomBytes(9).toString("base64url")}`,
      seq: ++this.seq,
      at: Date.now(),
    } as Occurrence;
    this.log.push(o);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    for (const fn of this.listeners) fn(o);
    return o;
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
    case "text":
      return {
        kind: "text",
        text: String(o.text ?? ""),
        images: Array.isArray(o.images) ? (o.images as string[]).map(String) : undefined,
      };
    case "widget":
      return {
        kind: "widget",
        prompt: String(o.prompt ?? ""),
        options: Array.isArray(o.options) ? (o.options as unknown[]).map(String) : [],
      };
    case "secret_request":
      return {
        kind: "secret_request",
        prompt: String(o.prompt ?? ""),
        label: String(o.label ?? ""),
      };
    default:
      throw new ComputerError("VALIDATION", "kind must be text, widget or secret_request");
  }
}
