import { createHmac, randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { phoneAccount } from "./phone-account";
import { whatsappLoginLink } from "./whatsapp-login-link";
import { connectionForSender } from "./whatsapp-connection";

let ready: Promise<void> | undefined;
function ensureCodes() {
  ready ??= db
    .run(sql`CREATE TABLE IF NOT EXISTS whatsapp_login (
    jid TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, issued_at INTEGER NOT NULL
  )`)
    .then(() => undefined)
    .catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
  return ready;
}
export function loginJid(phone: string) {
  const digits = phone.replaceAll(/[ +()-]/gu, "");
  return /^[1-9][0-9]{7,14}$/u.test(digits) ? `${digits}@s.whatsapp.net` : undefined;
}
function codeHash(jid: string, code: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("Sign-in unavailable");
  return createHmac("sha256", secret).update(`${jid}:${code}`).digest("hex");
}
async function identity(jid: string) {
  const phone = await phoneAccount(jid);
  if (phone)
    return phone.stage === "ready" ? { userId: phone.user_id, phoneId: phone.id } : undefined;
  const connection = await connectionForSender(jid);
  return connection ? { userId: connection.user_id, phoneId: null } : undefined;
}
/** Only authenticated transport ingress may issue a code; it never reaches the model. */
export async function issueWhatsAppCode(jid: string) {
  if (!loginJid(jid.split("@")[0] ?? "") || !(await identity(jid)))
    return "Your assistant is not connected yet. Send a message to finish setting it up, then send sign in again.";
  await ensureCodes();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = Date.now();
  const result = await db.run(sql`INSERT INTO whatsapp_login(jid, code_hash, expires_at, issued_at)
    VALUES(${jid}, ${codeHash(jid, code)}, ${now + 300_000}, ${now})
    ON CONFLICT(jid) DO UPDATE SET code_hash = excluded.code_hash,
      expires_at = excluded.expires_at, issued_at = excluded.issued_at, attempts = 0
    WHERE whatsapp_login.issued_at <= ${now - 30_000}`);
  return result.rowsAffected === 1
    ? `Your Expert sign-in code is ${code}. Open this link, then tap Sign in:\n${whatsappLoginLink(jid.split("@")[0]!, code)}\nIt expires in 5 minutes. Only use it if you are signing in. Never share this link or code.`
    : "Please wait 30 seconds before requesting another sign-in code.";
}
/** Atomic consumption prevents concurrent replay; every incorrect guess uses an attempt. */
export async function consumeWhatsAppCode(phone: string, code: string) {
  const jid = loginJid(phone);
  if (!jid || !/^\d{6}$/u.test(code)) return undefined;
  await ensureCodes();
  const result = await db.run(sql`DELETE FROM whatsapp_login WHERE jid = ${jid}
    AND code_hash = ${codeHash(jid, code)} AND expires_at > ${Date.now()} AND attempts < 5`);
  if (result.rowsAffected !== 1) {
    await db.run(
      sql`UPDATE whatsapp_login SET attempts = attempts + 1 WHERE jid = ${jid} AND attempts < 5`,
    );
    return undefined;
  }
  return identity(jid);
}
/** A verified phone attaches once. A concurrent email claim wins rather than being replaced. */
export async function attachPhoneLogin(phoneId: string, userId: string) {
  await db.run(sql`UPDATE phone_account SET user_id = ${userId}, claim_hash = NULL, claim_until = 0
    WHERE id = ${phoneId} AND user_id IS NULL AND stage = 'ready'`);
  const [row] = await db.all<{ user_id: string }>(
    sql`SELECT user_id FROM phone_account WHERE id = ${phoneId}`,
  );
  return row?.user_id;
}
