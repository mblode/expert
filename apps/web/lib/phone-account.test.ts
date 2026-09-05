import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "./db";
import {
  reservePhone,
  queuePhoneMessage,
  pendingPhoneMessages,
  markPhoneDelivered,
  leasePhone,
  releasePhone,
  advancePhone,
  phoneClaimLink,
  claimPhone,
  phoneComputer,
  ensurePhoneAccounts,
} from "./phone-account";
import { createComputerEnrollment, claimComputerEnrollment } from "./computer-enrollment";
import { activatePhoneConnection, connectionStatus } from "./whatsapp-connection";

const keys = Array.from({ length: 128 }, (_, i) => `test-model-key-${String(i).padStart(20, "0")}`);
let counter = 10_000_000;
const jid = () => `1555${counter++}@s.whatsapp.net`;
const reserve = () => reservePhone(jid(), 1000, keys).then((row) => row!);

describe("automatic private phone accounts", () => {
  it("collapses simultaneous first messages to one private account", async () => {
    const phone = jid();
    const rows = await Promise.all(
      Array.from({ length: 8 }, () => reservePhone(phone, 1000, keys)),
    );
    expect(new Set(rows.map((row) => row?.app)).size).toBe(1);
    expect(rows[0]?.id).toMatch(/^[a-f0-9]{32}$/u);
    expect(rows[0]?.app).toMatch(/^expert-[a-f0-9]{32}$/u);
    expect(rows[0]?.app).not.toContain(phone.split("@")[0]);
  });
  it("reserves the last capacity slot atomically", async () => {
    await ensurePhoneAccounts();
    const [countRow] = await db.all<{ count: number }>(
      sql`SELECT count(*) AS count FROM phone_account`,
    );
    const rows = await Promise.all(
      Array.from({ length: 6 }, () => reservePhone(jid(), countRow!.count + 1, keys)),
    );
    expect(rows.filter(Boolean)).toHaveLength(1);
    const allKeys = await db.all<{ model_key: string }>(sql`SELECT model_key FROM phone_account`);
    expect(new Set(allKeys.map((row) => row.model_key)).size).toBe(allKeys.length);
  });
  it("saves first messages once and retains them across failed delivery", async () => {
    const row = await reserve();
    await Promise.all(
      [1, 2, 3].map(() => queuePhoneMessage(row, { messageId: "first", message: "Hi" })),
    );
    expect(await pendingPhoneMessages(row.id)).toHaveLength(1);
    expect(await pendingPhoneMessages(row.id)).toHaveLength(1);
    await markPhoneDelivered(row.id, "first");
    expect(await pendingPhoneMessages(row.id)).toHaveLength(0);
  });
  it("leases a setup to one worker and refuses progress after lease loss", async () => {
    const rows = await Promise.all([leasePhone(), leasePhone()]);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
    const row = rows[0]!;
    await releasePhone(row);
    await expect(advancePhone(row, "ready")).rejects.toThrow("lease lost");
    await releasePhone(rows[1]!);
  });
  it("claims only by an unexpired token and never transfers an existing owner", async () => {
    const row = await reserve();
    await db.run(sql`UPDATE phone_account SET stage = 'ready' WHERE id = ${row.id}`);
    const token = new URL(await phoneClaimLink(row)).searchParams.get("claim")!;
    const users = Array.from({ length: 4 }, () => randomUUID());
    const claims = await Promise.all(users.map((user) => claimPhone(token, user)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner = users[claims.indexOf(true)]!;
    const owned = await phoneComputer(owner);
    expect(owned?.record.hubUrl).toBe(`https://${row.app}.fly.dev`);
    expect(await claimPhone(token, owner)).toBe(true);
    const other = await reserve();
    await db.run(sql`UPDATE phone_account SET stage = 'ready' WHERE id = ${other.id}`);
    const expired = new URL(await phoneClaimLink(other)).searchParams.get("claim")!;
    await db.run(sql`UPDATE phone_account SET claim_until = 0 WHERE id = ${other.id}`);
    expect(await claimPhone(expired, randomUUID())).toBe(false);
  });
  it("does not let an invitation and a phone claim allocate two computers to one user", async () => {
    const row = await reserve();
    await db.run(sql`UPDATE phone_account SET stage = 'ready' WHERE id = ${row.id}`);
    const phoneToken = new URL(await phoneClaimLink(row)).searchParams.get("claim")!;
    const email = `${randomUUID()}@example.com`;
    const userId = randomUUID();
    const invite = await createComputerEnrollment({
      email,
      hubUrl: `https://test-${randomUUID()}.fly.dev`,
      label: "Test",
      setupCode: "a".repeat(32),
      createdBy: "test",
    });
    const results = await Promise.all([
      claimPhone(phoneToken, userId),
      claimComputerEnrollment({ token: invite.token, userId, email, emailVerified: true }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("keeps the transport route on the same account after web claim", async () => {
    const row = await reserve();
    const credentials = {
      acct: row.id,
      jid: row.jid,
      connector_id: `whatsapp-${row.id}`,
      connector_secret: "c".repeat(40),
      delivery_secret: row.delivery_secret,
    };
    await activatePhoneConnection(row.id, `https://${row.app}.fly.dev`, row.jid, credentials);
    await activatePhoneConnection(row.id, `https://${row.app}.fly.dev`, row.jid, credentials);
    await db.run(sql`UPDATE phone_account SET stage = 'ready' WHERE id = ${row.id}`);
    const token = new URL(await phoneClaimLink(row)).searchParams.get("claim")!;
    const userId = randomUUID();
    await claimPhone(token, userId);
    const status = await connectionStatus(userId);
    expect(status?.state).toBe("active");
    await expect(
      activatePhoneConnection(randomUUID(), `https://wrong.fly.dev`, row.jid, credentials),
    ).rejects.toThrow();
  });
});
