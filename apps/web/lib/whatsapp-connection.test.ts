import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./db";
import {
  confirmConnection,
  connectionForSender,
  connectionStatus,
  deliveryRecipient,
  receiveConnectionCode,
  startConnection,
} from "./whatsapp-connection";

const draft = async () => {
  const id = randomUUID();
  const secret = `${randomUUID()}-${randomUUID()}`;
  const code = await startConnection(id, `https://${id}.fly.dev`, {
    acct: "expert",
    jid: "",
    connector_id: "whatsapp-expert",
    connector_secret: randomUUID(),
    delivery_secret: secret,
  });
  return { id, code, secret };
};
let phone = 61_400_000_000;
const jid = () => `${phone++}@s.whatsapp.net`;
describe("shared number isolation", () => {
  it("requires both transport verification and owner confirmation", async () => {
    const a = await draft();
    const sender = jid();
    expect(await receiveConnectionCode(a.code, "123456789@lid")).toBe(false);
    expect(await receiveConnectionCode(a.code, sender)).toBe(true);
    expect(await connectionForSender(sender)).toBeUndefined();
    expect(await deliveryRecipient(a.secret, "expert")).toBeUndefined();
    await expect(
      confirmConnection(randomUUID(), sender.split("@")[0]!, async () => {}),
    ).rejects.toThrow();
    await confirmConnection(a.id, sender.split("@")[0]!, async (row) => {
      expect(row.jid).toBe(sender);
    });
    const connected = await connectionForSender(sender);
    expect(connected?.user_id).toBe(a.id);
    expect(await deliveryRecipient(a.secret, "expert")).toBe(sender);
    expect(await deliveryRecipient(a.secret, "other")).toBeUndefined();
    expect(await deliveryRecipient(randomUUID(), "expert")).toBeUndefined();
  });
  it("gives one phone to only one competing workspace", async () => {
    const a = await draft();
    const b = await draft();
    const sender = jid();
    const results = await Promise.all([
      receiveConnectionCode(a.code, sender),
      receiveConnectionCode(b.code, sender),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("does not let a second phone replace a claimed candidate", async () => {
    const a = await draft();
    const sender = jid();
    expect(await receiveConnectionCode(a.code, sender)).toBe(true);
    expect(await receiveConnectionCode(a.code, jid())).toBe(false);
  });
  it("keeps a failed remote bind inactive and reconciles the same identity on retry", async () => {
    const a = await draft();
    const sender = jid();
    const number = sender.split("@")[0]!;
    await receiveConnectionCode(a.code, sender);
    await expect(
      confirmConnection(a.id, number, async () => {
        throw new Error("response lost");
      }),
    ).rejects.toThrow();
    const binding = await connectionStatus(a.id);
    expect(binding?.state).toBe("binding");
    expect(await connectionForSender(sender)).toBeUndefined();
    await confirmConnection(a.id, number, async () => {});
    await confirmConnection(a.id, number, async () => {
      throw new Error("must not repeat after activation");
    });
    const active = await connectionStatus(a.id);
    expect(active?.state).toBe("active");
  });
  it("expires codes and stores hashes rather than the code or delivery credential", async () => {
    const a = await draft();
    const [row] = await db.all<{ code_hash: string; delivery_hash: string }>(
      sql`SELECT code_hash, delivery_hash FROM whatsapp_connection WHERE user_id = ${a.id}`,
    );
    expect(row?.code_hash).not.toBe(a.code);
    expect(row?.delivery_hash).not.toBe(a.secret);
    await db.run(sql`UPDATE whatsapp_connection SET expires_at = 0 WHERE user_id = ${a.id}`);
    expect(await receiveConnectionCode(a.code, jid())).toBe(false);
  });
});
