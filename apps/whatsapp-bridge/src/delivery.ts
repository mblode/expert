import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Durable send receipts. An acknowledgement lost after sending remains uncertain. */
export class DeliveryReceipts {
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}

  async send(
    key: string,
    jid: string,
    text: string,
    deliver: () => Promise<void>,
  ): Promise<boolean> {
    if (!key || key.length > 256) throw new Error("invalid delivery identity");
    const name = createHash("sha256").update(key).digest("hex");
    const hash = createHash("sha256")
      .update(JSON.stringify([jid, text]))
      .digest("hex");
    const path = join(this.directory, `${name}.json`);
    let receipt: { hash: string; sent: boolean } | undefined;
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
      if (
        !raw ||
        typeof raw !== "object" ||
        !("hash" in raw) ||
        !("sent" in raw) ||
        typeof raw.hash !== "string" ||
        typeof raw.sent !== "boolean"
      ) {
        throw new Error("invalid delivery receipt");
      }
      receipt = { hash: raw.hash, sent: raw.sent };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (receipt && (receipt.hash !== hash || typeof receipt.sent !== "boolean")) {
      throw new Error("delivery identity belongs to different content");
    }
    if (receipt?.sent) return true;
    const pending = this.running.get(name);
    if (pending) {
      await pending;
      return true;
    }
    if (receipt)
      throw new Error("delivery outcome is uncertain; inspect the chat before sending again");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const save = (sent: boolean) => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ hash, sent }), { mode: 0o600 });
      renameSync(temporary, path);
    };
    save(false);
    const work = Promise.resolve()
      .then(deliver)
      .then(() => save(true));
    this.running.set(name, work);
    try {
      await work;
      return false;
    } finally {
      this.running.delete(name);
    }
  }
}
