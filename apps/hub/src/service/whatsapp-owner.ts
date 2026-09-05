import { ComputerError } from "@computer/shared";
import { readTokenFile, writeTokenFile } from "./provision.ts";

/** The identity comes from verified setup, never from an agent's message. */
export class WhatsAppOwner {
  readonly identity: { acct: string; jid: string };

  constructor(
    acct: string,
    private readonly path?: string,
    initialJid = "",
  ) {
    const saved = path ? readTokenFile(path, "WhatsApp owner") : undefined;
    const row = saved?.[0] as { acct?: unknown; jid?: unknown } | undefined;
    if (row && (row.acct !== acct || typeof row.jid !== "string" || !this.valid(row.jid))) {
      throw new Error("Invalid persisted WhatsApp owner");
    }
    this.identity = { acct, jid: typeof row?.jid === "string" ? row.jid : initialJid };
  }

  private valid(jid: string): boolean {
    return /^[1-9][0-9]{7,14}@s\.whatsapp\.net$/u.test(jid);
  }

  bind(jid: string): void {
    if (!this.valid(jid)) throw new ComputerError("VALIDATION", "a verified phone JID is required");
    // Changing an established owner needs an explicit recovery flow. A setup
    // retry may repeat the same identity, but cannot transfer an active box.
    if (this.identity.jid && this.identity.jid !== jid) {
      throw new ComputerError("CONFLICT", "this computer already has a WhatsApp owner");
    }
    if (this.path) writeTokenFile(this.path, [{ acct: this.identity.acct, jid }]);
    this.identity.jid = jid;
  }
}
