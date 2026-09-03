import { ComputerError, MAX_WIDGET_OPTIONS } from "@computer/shared";
import type { MessageBody, OccurrenceKind } from "@computer/shared";
import type { Desk } from "../desk/types.ts";
import type { ConversationEntry, ConversationPage, ConversationRegistry } from "./conversations.ts";

/**
 * The voice, on the Bot's own thread.
 *
 * Plain model text is a private scratchpad. The human sees exactly the
 * occurrences in this log and nothing else, so a turn that ends without a
 * send is silence, which is legal for a routine and a bug for a person.
 *
 * Two rules are enforced rather than asked for in a prompt, because a prompt
 * is a request and this is the product guarantee:
 *
 *   1. `widget` and `secret_request` END the turn. Stop and wait.
 *   2. A second send after the turn ended is rejected.
 *
 * A turn re-opens when the human speaks again, a message, a widget answer,
 * or a delivered secret. That is the same boundary in all three cases: the
 * person did something, so the agent may talk again.
 *
 * All of that now lives in `ConversationRegistry`, applied to whichever
 * conversation the turn belongs to, and this class is what is left: the seat
 * route's end of it, plus the clipboard, which is the one part of a turn
 * that is a fact about a screen rather than about a log. There is deliberately
 * no second copy of the rules here. There used to be, and it was the bug: one
 * Bot had one `turnEnded` flag, so a widget on hello.expert made the next
 * WhatsApp reply `CONFLICT`.
 */

export type SendBody =
  | { kind: "text"; text: string; images?: string[] }
  | { kind: "widget"; prompt: string; options: string[] }
  | { kind: "secret_request"; prompt: string; label: string };

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
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  /** The Bot's seat conversation, resolved once. Idempotent by route. */
  private seatId: string | undefined;

  /** `secretTtlMs` is injectable so tests do not wait out the real window. */
  constructor(
    private readonly desk: Desk,
    private readonly bot: string,
    private readonly conversations: ConversationRegistry,
    private readonly secretTtlMs: number = SECRET_TTL_MS,
  ) {}

  /**
   * The conversation this voice speaks into: the Bot's `seat` route, which
   * is hello.expert, the phone, the eve TUI and anything else that arrives
   * with no turn binding.
   */
  conversationId(): string {
    this.seatId ??= this.conversations.resolveSeat(this.bot).id;
    return this.seatId;
  }

  /** Agent.SendMessage with no turn binding. */
  send(body: SendBody): { conversation_id: string; occurrence_id: string; turn_ended: boolean } {
    return this.conversations.send(
      this.conversationId(),
      { bot: this.bot, kind: "bot" },
      buildBody(body),
    );
  }

  /** Seat answers a widget. Re-opens the turn and records the choice. */
  answerWidget(occurrenceId: string, answer: string): void {
    this.conversations.answerWidget(this.conversationId(), occurrenceId, answer);
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
  async provideSecret(occurrenceId: string, value: string): Promise<void> {
    const conversation = this.conversationId();
    // Once. A delivered request cannot be replayed to rewrite the clipboard
    // and re-open the turn behind the agent's back; the registry is what
    // says whether this one is still open.
    const open = this.conversations.requireOpenSecret(conversation, occurrenceId);
    if (!value) {
      throw new ComputerError("VALIDATION", "secret value is required");
    }
    const label = open.body.kind === "secret_request" ? open.body.label : "the value";
    await this.desk.clipboardSet(value);
    this.scheduleClear(value);
    this.conversations.close(conversation, occurrenceId, `${label} is on the clipboard, paste it.`);
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
    return this.conversations.pendingRequest(this.conversationId())?.body.kind === "secret_request";
  }

  /** Cursor page, oldest first. `cursor` is the last seq the caller has. */
  page(cursor?: string, limit?: number): ConversationPage {
    return this.conversations.page(this.conversationId(), cursor, limit);
  }

  /** The thread as a list, for tests and for anything that wants the tail. */
  entries(): ConversationEntry[] {
    return this.page(undefined, 500).entries;
  }
}

/**
 * Validate a send and normalise it into the stored body.
 *
 * Module-level rather than a method because both callers need it: the seat
 * thread through `VoiceService.send`, and a bound turn through
 * `ConversationRegistry.send` in the Agent handler. The rules are the wire
 * contract, so there is one copy of them and the two paths cannot drift.
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
