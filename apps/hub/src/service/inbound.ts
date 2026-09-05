import type { ClockClient } from "./clock.ts";
import { createHash } from "node:crypto";
import { ComputerError } from "@computer/shared";
import { readTokenFile, writeTokenFile } from "./provision.ts";

interface Reply {
  status: number;
  body: string;
}
interface Receipt {
  key: string;
  hash: string;
  reply?: Reply;
  payload?: string;
  route?: { acct: string; jid: string };
  delivered?: boolean;
  released?: boolean;
  acknowledged?: boolean;
  retry_at?: number;
}

/** A retry may recover a reply, never silently repeat an uncertain external action. */
export class InboundService {
  private readonly receipts = new Map<string, Receipt>();
  private flushing = false;
  private readonly running = new Map<string, Promise<Reply>>();

  constructor(private readonly path?: string) {
    for (const value of path ? (readTokenFile(path, "inbound receipts") ?? []) : []) {
      const row = value as Receipt;
      if (
        !row ||
        typeof row.key !== "string" ||
        typeof row.hash !== "string" ||
        (row.reply && (!Number.isInteger(row.reply.status) || typeof row.reply.body !== "string"))
      ) {
        throw new Error("invalid inbound receipt store");
      }
      if (row.route && (typeof row.route.acct !== "string" || typeof row.route.jid !== "string")) {
        throw new Error("invalid inbound delivery route");
      }
      if (row.route && !row.reply) row.reply = interruptedReply();
      this.receipts.set(row.key, row);
    }
  }

  private save(): void {
    if (this.path) writeTokenFile(this.path, [...this.receipts.values()]);
  }

  execute(
    key: string,
    payload: Uint8Array,
    work: () => Promise<Reply>,
    route?: Receipt["route"],
  ): Promise<Reply> {
    const hash = createHash("sha256").update(payload).digest("hex");
    const previous = this.receipts.get(key);
    if (previous && previous.hash !== hash) {
      throw new ComputerError(
        "CONFLICT",
        "this message id was already used with different content",
      );
    }
    if (previous?.reply) return Promise.resolve(previous.reply);
    const active = this.running.get(key);
    if (active) return active;
    if (previous) {
      throw new ComputerError(
        "CONFLICT",
        "this request was interrupted; inspect its conversation before retrying the work",
      );
    }
    this.receipts.set(key, {
      key,
      hash,
      ...(route ? { route, payload: Buffer.from(payload).toString("utf-8") } : {}),
    });
    this.save();
    const pending = Promise.resolve()
      .then(work)
      .then((reply) => {
        this.receipts.set(key, { ...this.receipts.get(key)!, reply });
        this.save();
        return reply;
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, pending);
    return pending;
  }

  /** Durable acceptance precedes the HTTP acknowledgement. This driver owns delivery. */
  async accept(
    key: string,
    payload: Uint8Array,
    route: NonNullable<Receipt["route"]>,
    work: () => Promise<Reply>,
    clock: ClockClient,
  ): Promise<void> {
    const previous = this.receipts.get(key);
    if (previous) {
      const hash = createHash("sha256").update(payload).digest("hex");
      if (previous.hash !== hash)
        throw new ComputerError(
          "CONFLICT",
          "this message id was already used with different content",
        );
      if (previous.delivered) return;
    }
    await clock.checkAt(createHash("sha256").update(key).digest("hex"), Date.now());
    const pending = this.execute(key, payload, work, route);
    void pending.catch(() => {
      try {
        this.receipts.set(key, { ...this.receipts.get(key)!, reply: interruptedReply() });
        this.save();
      } catch {
        console.error("interrupted WhatsApp work could not be persisted");
      }
    });
  }

  async publish(
    key: string,
    route: NonNullable<Receipt["route"]>,
    text: string,
    clock: ClockClient,
  ): Promise<void> {
    const hash = createHash("sha256")
      .update(JSON.stringify([route, text]))
      .digest("hex");
    const previous = this.receipts.get(key);
    if (previous) {
      if (previous.hash !== hash)
        throw new ComputerError("CONFLICT", "notification identity belongs to different content");
      return;
    }
    await clock.checkAt(createHash("sha256").update(key).digest("hex"), Date.now());
    this.receipts.set(key, {
      key,
      hash,
      route,
      reply: { status: 200, body: JSON.stringify({ reply: text }) },
    });
    this.save();
  }

  async flush(
    send: (acct: string, jid: string, text: string, key: string) => Promise<{ sent: boolean }>,
    clock?: ClockClient,
  ): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const row of this.receipts.values()) {
        if (row.delivered) {
          if (clock && !row.released) {
            // Persist delivery before releasing its wake. A crash can repeat a
            // cancellation, never lose an undelivered result's wake registration.
            await clock.hold(createHash("sha256").update(row.key).digest("hex"), 0);
            row.released = true;
            this.save();
          }
          continue;
        }
        if (!row.route || (row.retry_at ?? 0) > Date.now()) continue;
        const complete = !!row.reply;
        if (!complete && row.acknowledged) continue;
        let text = "On it. I’ll send the result here.";
        if (row.reply) {
          try {
            const body = JSON.parse(row.reply.body) as { reply?: unknown };
            text =
              row.reply.status === 200 && typeof body.reply === "string" && body.reply.trim()
                ? body.reply
                : "This request could not finish. Please check the conversation before retrying.";
          } catch {
            text = "This request could not finish. Please check the conversation before retrying.";
          }
        }
        const identity =
          createHash("sha256").update(row.key).digest("hex") + (complete ? ":result" : ":accepted");
        try {
          const delivered = await send(row.route.acct, row.route.jid, text, identity);
          if (!delivered.sent) throw new Error("delivery refused");
          // Execution may have completed while the acknowledgement was in flight.
          const latest = this.receipts.get(row.key)!;
          this.receipts.set(row.key, {
            ...latest,
            ...(complete ? { delivered: true } : { acknowledged: true }),
            retry_at: undefined,
          });
        } catch {
          this.receipts.set(row.key, {
            ...this.receipts.get(row.key)!,
            retry_at: Date.now() + 60_000,
          });
        }
        this.save();
      }
    } finally {
      this.flushing = false;
    }
  }
}

function interruptedReply(): Reply {
  return {
    status: 200,
    body: JSON.stringify({
      reply:
        "This request was interrupted and its outcome is uncertain. Check the conversation before asking me to repeat the work.",
    }),
  };
}
