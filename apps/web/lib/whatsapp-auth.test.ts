import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { db } from "./db";
import { whatsappAuth } from "./whatsapp-auth";
import { reservePhone, phoneAccount } from "./phone-account";
import { issueWhatsAppCode } from "./whatsapp-login";

const secret = "test-secret-for-whatsapp-login-at-least-32-characters";
const auth = betterAuth({
  baseURL: "http://localhost:3099",
  secret,
  database: drizzleAdapter(db, { provider: "sqlite" }),
  plugins: [whatsappAuth()],
});
beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = secret;
  await db.run(
    sql`CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  );
  await db.run(
    sql`CREATE TABLE session (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT)`,
  );
});
const request = (phone: string, code: string, origin = "http://localhost:3099") =>
  auth.handler(
    new Request("http://localhost:3099/api/auth/sign-in/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ phone, code }),
    }),
  );
it("creates a phone account session, preserves identity on subsequent login and refuses replay", async () => {
  const jid = "15551112222@s.whatsapp.net";
  const row = (await reservePhone(jid, 5, ["dedicated-test-model-key-1234567890"]))!;
  await db.run(sql`UPDATE phone_account SET stage = 'ready' WHERE id = ${row.id}`);
  const reply = await issueWhatsAppCode(jid);
  const [code] = reply.match(/\b[0-9]{6}\b/u)!;
  const blocked = await request("15551112222", code!, "https://untrusted.example");
  expect(blocked.status).toBe(403);
  const response = await request("15551112222", code!);
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  const body = await response.json();
  const linked = await phoneAccount(jid);
  expect(linked?.user_id).toBe(body.user.id);
  const replay = await request("15551112222", code!);
  expect(replay.status).toBe(400);
  const nextReply = await issueWhatsAppCode(jid);
  const [again] = nextReply.match(/\b[0-9]{6}\b/u)!;
  const repeated = await request("15551112222", again!);
  const repeatedBody = await repeated.json();
  expect(repeatedBody.user.id).toBe(body.user.id);
});
