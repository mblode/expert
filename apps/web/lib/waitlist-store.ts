import { eq, sql } from "drizzle-orm";

import { waitlist } from "../db/waitlist";
import { db } from "./db";

/**
 * Created on first use like `onboarding` and `invite`: nothing runs a
 * migration against Turso, so a table exists only if some code makes it.
 * Memoised per warm instance, dropped on failure so the next request retries.
 */
let waitlistTableReady: Promise<void> | undefined;

function ensureWaitlistTable(): Promise<void> {
  waitlistTableReady ??= db
    .run(
      sql`
        CREATE TABLE IF NOT EXISTS waitlist (
          email TEXT PRIMARY KEY NOT NULL,
          created_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          notified_at INTEGER
        )
      `,
    )
    .then(() => undefined)
    .catch((error: unknown) => {
      waitlistTableReady = undefined;
      throw error;
    });
  return waitlistTableReady;
}

function waitlistKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Record the request. A second request from the same address is not a second row. */
export async function addToWaitlist(
  email: string,
  source: string,
): Promise<{ created: boolean; notifiedAt: Date | null }> {
  await ensureWaitlistTable();
  const key = waitlistKey(email);
  const [existing] = await db.select().from(waitlist).where(eq(waitlist.email, key)).limit(1);
  if (existing) {
    return { created: false, notifiedAt: existing.notifiedAt ?? null };
  }
  await db.insert(waitlist).values({ createdAt: new Date(), email: key, source });
  return { created: true, notifiedAt: null };
}

export async function markWaitlistNotified(email: string, at: Date = new Date()): Promise<void> {
  await ensureWaitlistTable();
  await db
    .update(waitlist)
    .set({ notifiedAt: at })
    .where(eq(waitlist.email, waitlistKey(email)));
}

export async function waitlistCount(): Promise<number> {
  await ensureWaitlistTable();
  const rows = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM waitlist`);
  return Number(rows[0]?.n ?? 0);
}
