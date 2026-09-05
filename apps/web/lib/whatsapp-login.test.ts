import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "./db";
import { reservePhone } from "./phone-account";
import {
  attachPhoneLogin,
  consumeWhatsAppCode,
  issueWhatsAppCode,
  loginJid,
} from "./whatsapp-login";

let n = 10_000_000;
const keys = Array.from({ length: 100 }, (_, i) => `test-key-${String(i).padStart(25, "0")}`);
async function readyPhone() {
  const jid = `1555${n++}@s.whatsapp.net`;
  const row = (await reservePhone(jid, 100, keys))!;
  await db.run(sql`UPDATE phone_account SET stage = 'ready' WHERE id = ${row.id}`);
  return row;
}
const codeFrom = (reply: string) => reply.match(/\b[0-9]{6}\b/u)![0];
beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-whatsapp-login-at-least-32-characters";
});
describe("WhatsApp sign-in", () => {
  it("requires an international number and rejects suffix injection", () => {
    expect(loginJid("+61 456 455 551")).toBe("61456455551@s.whatsapp.net");
    expect(loginJid("0456455551")).toBeUndefined();
    expect(loginJid("61456455551@s.whatsapp.net")).toBeUndefined();
  });
  it("does not issue codes for unbound numbers or unfinished computers", async () => {
    expect(await issueWhatsAppCode("15559999999@s.whatsapp.net")).not.toMatch(/code is/u);
    const row = (await reservePhone(`1555${n++}@s.whatsapp.net`, 100, keys))!;
    expect(await issueWhatsAppCode(row.jid)).not.toMatch(/code is/u);
  });
  it("hashes codes, binds them to the phone and consumes once concurrently", async () => {
    const row = await readyPhone();
    const code = codeFrom(await issueWhatsAppCode(row.jid));
    const stored = await db.all<{ code_hash: string }>(
      sql`SELECT code_hash FROM whatsapp_login WHERE jid = ${row.jid}`,
    );
    expect(stored[0]!.code_hash).not.toContain(code);
    expect(await consumeWhatsAppCode("15559999999", code)).toBeUndefined();
    const results = await Promise.all(
      [1, 2].map(() => consumeWhatsAppCode(row.jid.split("@")[0]!, code)),
    );
    expect(results.filter(Boolean)).toEqual([{ userId: null, phoneId: row.id }]);
  });
  it("expires codes and locks after five guesses", async () => {
    const row = await readyPhone();
    const code = codeFrom(await issueWhatsAppCode(row.jid));
    const number = row.jid.split("@")[0]!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect(await consumeWhatsAppCode(number, wrong)).toBeUndefined();
    expect(await consumeWhatsAppCode(number, code)).toBeUndefined();
    await db.run(
      sql`UPDATE whatsapp_login SET attempts = 0, expires_at = 0 WHERE jid = ${row.jid}`,
    );
    expect(await consumeWhatsAppCode(number, code)).toBeUndefined();
  });
  it("throttles resends and replaces an old code after cooldown", async () => {
    const row = await readyPhone();
    await issueWhatsAppCode(row.jid);
    expect(await issueWhatsAppCode(row.jid)).toContain("wait 30 seconds");
    await db.run(sql`UPDATE whatsapp_login SET issued_at = 0 WHERE jid = ${row.jid}`);
    expect(await issueWhatsAppCode(row.jid)).toContain("code is");
  });
  it("never replaces an existing phone owner", async () => {
    const row = await readyPhone();
    const owner = randomUUID();
    expect(await attachPhoneLogin(row.id, owner)).toBe(owner);
    expect(await attachPhoneLogin(row.id, randomUUID())).toBe(owner);
    const code = codeFrom(await issueWhatsAppCode(row.jid));
    expect(await consumeWhatsAppCode(row.jid.split("@")[0]!, code)).toEqual({
      userId: owner,
      phoneId: row.id,
    });
  });
});
