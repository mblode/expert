import { phoneComputer } from "./phone-account";
import { ensurePhoneAccounts, ensureEnrollmentTable } from "./account-tables";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "./db";
import { computersFromEnv } from "./computers";
import type { ComputerRecord } from "./computers";

/** A claim and its ownership are one row, so there is no dual-write window. */
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const emailKey = (email: string) => email.trim().toLowerCase();

interface OwnedComputer {
  record: ComputerRecord;
  setupCode: string;
}

/** Never serialise this object to a client: it includes the pairing credential. */
export async function ownedComputer(userId: string): Promise<OwnedComputer | undefined> {
  await ensureEnrollmentTable();
  const rows = await db.all<{
    id: string;
    hub_url: string;
    label: string;
    setup_code: string;
  }>(sql`SELECT id, hub_url, label, setup_code FROM computer_enrollment WHERE user_id = ${userId}`);
  const [row] = rows;
  return row
    ? {
        record: {
          id: row.id,
          hubUrl: row.hub_url,
          label: row.label,
          setupCodeEnv: "ENROLLED_COMPUTER_SETUP_CODE",
        },
        setupCode: row.setup_code,
      }
    : phoneComputer(userId);
}

/** Invitations permit registration, not access to a computer before redemption. */
export async function hasComputerInvitation(email: string): Promise<boolean> {
  await ensureEnrollmentTable();
  const rows = await db.all(sql`SELECT id FROM computer_enrollment
    WHERE email = ${emailKey(email)} AND (user_id IS NOT NULL OR expires_at > ${Date.now()}) LIMIT 1`);
  return rows.length > 0;
}

export async function createComputerEnrollment(input: {
  email: string;
  hubUrl: string;
  label: string;
  setupCode: string;
  createdBy: string;
}): Promise<{ token: string; expiresAt: string }> {
  const email = emailKey(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254)
    throw new Error("Enter the recipient's email address.");
  const hubUrl = input.hubUrl.replace(/\/+$/u, "");
  // An operator supplies this, but it must not turn Pair into an SSRF proxy.
  if (!/^https:\/\/[a-z0-9][a-z0-9-]{0,61}\.fly\.dev$/u.test(hubUrl))
    throw new Error("Use the computer's public HTTPS Fly address.");
  if (computersFromEnv(process.env).some((computer) => computer.hubUrl === hubUrl))
    throw new Error("Existing shared computers cannot be offered for signup.");
  const label = input.label.trim();
  if (!label || label.length > 64 || input.setupCode.length < 16 || input.setupCode.length > 512)
    throw new Error("Enter a name and the computer's setup credential.");
  await ensureEnrollmentTable();
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expires = now + 7 * 24 * 60 * 60 * 1000;
  // Unique hub URL is also the capacity barrier: changing the label cannot
  // make one Machine available to two people. Only an unclaimed invitation
  // with the same recipient and credential can be renewed.
  const result = await db.run(sql`INSERT INTO computer_enrollment
    (id, hub_url, label, setup_code, email, token_hash, expires_at, created_at, created_by)
    VALUES (${`computer-${randomUUID()}`}, ${hubUrl}, ${label}, ${input.setupCode},
      ${email}, ${digest(token)}, ${expires}, ${now}, ${input.createdBy})
    ON CONFLICT(hub_url) DO UPDATE SET token_hash = excluded.token_hash,
      expires_at = excluded.expires_at
    WHERE computer_enrollment.user_id IS NULL AND computer_enrollment.email = excluded.email
      AND computer_enrollment.setup_code = excluded.setup_code`);
  if (result.rowsAffected !== 1)
    throw new Error("This computer already belongs to another invitation or account.");
  return { token, expiresAt: new Date(expires).toISOString() };
}

export async function claimComputerEnrollment(input: {
  token: string;
  userId: string;
  email: string;
  emailVerified: boolean;
}): Promise<boolean> {
  if (!input.emailVerified || !/^[A-Za-z0-9_-]{43}$/u.test(input.token)) return false;
  await ensureEnrollmentTable();
  await ensurePhoneAccounts();
  const hash = digest(input.token);
  const email = emailKey(input.email);
  // One conditional write, including the one-computer-per-user check. SQLite
  // serialises competing claims; the unique constraint is the final barrier.
  await db.run(sql`UPDATE computer_enrollment SET user_id = ${input.userId}, claimed_at = ${Date.now()}
    WHERE token_hash = ${hash} AND email = ${email} AND user_id IS NULL
      AND expires_at > ${Date.now()}
      AND NOT EXISTS (SELECT 1 FROM computer_enrollment WHERE user_id = ${input.userId})
      AND NOT EXISTS (SELECT 1 FROM phone_account WHERE user_id = ${input.userId})`);
  const rows = await db.all(sql`SELECT id FROM computer_enrollment
    WHERE token_hash = ${hash} AND email = ${email} AND user_id = ${input.userId}`);
  return rows.length === 1;
}
