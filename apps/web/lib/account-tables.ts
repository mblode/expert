import { sql } from "drizzle-orm";
import { db } from "./db";

let enrollmentReady: Promise<void> | undefined;
export function ensureEnrollmentTable(): Promise<void> {
  enrollmentReady ??= db
    .run(sql`CREATE TABLE IF NOT EXISTS computer_enrollment (
    id TEXT PRIMARY KEY NOT NULL,
    hub_url TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    setup_code TEXT NOT NULL,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    user_id TEXT UNIQUE,
    claimed_at INTEGER
  )`)
    .then(() => undefined)
    .catch((error: unknown) => {
      enrollmentReady = undefined;
      throw error;
    });
  return enrollmentReady;
}

let ready: Promise<void> | undefined;
export function ensurePhoneAccounts() {
  ready ??= (async () => {
    await db.run(sql`CREATE TABLE IF NOT EXISTS phone_account (
      id TEXT PRIMARY KEY, jid TEXT NOT NULL UNIQUE, app TEXT NOT NULL UNIQUE,
      setup_code TEXT NOT NULL, clock_secret TEXT NOT NULL, delivery_secret TEXT NOT NULL,
      model_key TEXT NOT NULL UNIQUE,
      stage TEXT NOT NULL DEFAULT 'app', lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
      user_id TEXT UNIQUE, claim_hash TEXT UNIQUE, claim_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0)`);
    await db.run(sql`CREATE TABLE IF NOT EXISTS phone_inbox (
      account_id TEXT NOT NULL, message_id TEXT NOT NULL, body TEXT NOT NULL,
      created_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id, message_id))`);
  })().catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}
