import { ensureEnrollmentTable, ensurePhoneAccounts } from "./account-tables";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db";

export { ensurePhoneAccounts } from "./account-tables";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export interface PhoneAccount {
  id: string;
  jid: string;
  app: string;
  setup_code: string;
  clock_secret: string;
  delivery_secret: string;
  model_key: string;
  stage: string;
  lease: string | null;
  lease_until: number;
  user_id: string | null;
  claim_hash: string | null;
  claim_until: number;
}
export async function phoneAccount(jid: string) {
  await ensurePhoneAccounts();
  const [row] = await db.all<PhoneAccount>(sql`SELECT * FROM phone_account WHERE jid = ${jid}`);
  return row;
}
/** The unique phone and one INSERT/SELECT reserve capacity before any Fly spend. */
function configuredModelKeys(): string[] {
  const keys: unknown = JSON.parse(process.env.EXPERT_MODEL_KEYS ?? "[]");
  if (
    !Array.isArray(keys) ||
    keys.some((key) => typeof key !== "string" || key.length < 20) ||
    new Set(keys).size !== keys.length
  )
    throw new Error("Invalid account key pool");
  return keys;
}
export async function reservePhone(
  jid: string,
  limit: number,
  keys = configuredModelKeys(),
): Promise<PhoneAccount | undefined> {
  if (!/^[1-9][0-9]{7,14}@s\.whatsapp\.net$/u.test(jid)) throw new Error("Verified phone required");
  await ensurePhoneAccounts();
  const id = randomUUID().replaceAll("-", "");
  await db.run(sql`INSERT INTO phone_account
    (id, jid, app, setup_code, clock_secret, delivery_secret, model_key, created_at)
    SELECT ${id}, ${jid}, ${`expert-${id.replaceAll("-", "")}`},
      ${randomBytes(32).toString("base64url")}, ${randomBytes(32).toString("base64url")},
      ${randomBytes(32).toString("base64url")},
      json_extract(${JSON.stringify(keys)}, '$[' || (SELECT count(*) FROM phone_account) || ']'), ${Date.now()}
    WHERE (SELECT count(*) FROM phone_account) < ${Number.isFinite(limit) ? Math.max(0, Math.min(keys.length, Math.floor(limit))) : 0}
    ON CONFLICT(jid) DO NOTHING`);
  return phoneAccount(jid);
}
export async function queuePhoneMessage(account: PhoneAccount, body: Record<string, unknown>) {
  const encoded = JSON.stringify(body);
  if (encoded.length > 8 * 1024 * 1024) throw new Error("Message too large");
  await db.run(sql`INSERT INTO phone_inbox(account_id, message_id, body, created_at)
    VALUES(${account.id}, ${String(body.messageId)}, ${encoded}, ${Date.now()})
    ON CONFLICT(account_id, message_id) DO NOTHING`);
}
export async function leasePhone() {
  await ensurePhoneAccounts();
  const lease = randomUUID();
  const now = Date.now();
  await db.run(sql`UPDATE phone_account SET lease = ${lease}, lease_until = ${now + 180_000}
    WHERE id = (SELECT id FROM phone_account WHERE lease_until < ${now} AND next_attempt <= ${now}
      AND (stage != 'ready' OR EXISTS (SELECT 1 FROM phone_inbox WHERE account_id = phone_account.id AND delivered = 0))
      ORDER BY created_at LIMIT 1) AND lease_until < ${now}`);
  const [row] = await db.all<PhoneAccount>(sql`SELECT * FROM phone_account WHERE lease = ${lease}`);
  return row;
}
export async function advancePhone(row: PhoneAccount, stage: string) {
  const result = await db.run(sql`UPDATE phone_account SET stage = ${stage}
    WHERE id = ${row.id} AND lease = ${row.lease} AND lease_until > ${Date.now()}`);
  if (result.rowsAffected !== 1) throw new Error("Provisioning lease lost");
  row.stage = stage;
}
export async function releasePhone(row: PhoneAccount) {
  await db.run(sql`UPDATE phone_account SET lease = NULL, lease_until = 0, next_attempt = ${Date.now() + 15_000}
    WHERE id = ${row.id} AND lease = ${row.lease}`);
}
export async function pendingPhoneMessages(id: string) {
  return db.all<{ message_id: string; body: string }>(sql`SELECT message_id, body FROM phone_inbox
    WHERE account_id = ${id} AND delivered = 0 ORDER BY created_at LIMIT 1`);
}
export async function markPhoneDelivered(id: string, messageId: string) {
  await db.run(
    sql`UPDATE phone_inbox SET delivered = 1 WHERE account_id = ${id} AND message_id = ${messageId}`,
  );
}
export async function phoneClockTargets() {
  await ensurePhoneAccounts();
  return db.all<{ app: string; clock_secret: string }>(
    sql`SELECT app, clock_secret FROM phone_account WHERE stage IN ('health', 'bind', 'ready')`,
  );
}
export async function phoneClaimLink(row: PhoneAccount) {
  if (row.user_id) return "https://hello.expert/";
  const token = randomBytes(32).toString("base64url");
  await db.run(sql`UPDATE phone_account SET claim_hash = ${digest(token)}, claim_until = ${Date.now() + 15 * 60_000}
    WHERE id = ${row.id} AND user_id IS NULL`);
  return `https://hello.expert/start?claim=${token}`;
}
/** Ownership lives on the phone row. A claim is single-use and cannot replace an owner. */
export async function claimPhone(token: string, userId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  await ensurePhoneAccounts();
  await ensureEnrollmentTable();
  await db.run(sql`UPDATE phone_account SET user_id = ${userId}
    WHERE claim_hash = ${digest(token)} AND claim_until > ${Date.now()} AND user_id IS NULL
      AND stage = 'ready' AND NOT EXISTS (SELECT 1 FROM phone_account WHERE user_id = ${userId})
      AND NOT EXISTS (SELECT 1 FROM computer_enrollment WHERE user_id = ${userId})`);
  const rows = await db.all(
    sql`SELECT id FROM phone_account WHERE claim_hash = ${digest(token)} AND user_id = ${userId}`,
  );
  return rows.length === 1;
}
export async function phoneComputer(userId: string) {
  await ensurePhoneAccounts();
  const [row] = await db.all<PhoneAccount>(
    sql`SELECT * FROM phone_account WHERE user_id = ${userId}`,
  );
  return row
    ? {
        record: {
          id: row.app,
          hubUrl: `https://${row.app}.fly.dev`,
          label: "My assistant",
          setupCodeEnv: "PHONE_COMPUTER_SETUP_CODE",
        },
        setupCode: row.setup_code,
      }
    : undefined;
}
