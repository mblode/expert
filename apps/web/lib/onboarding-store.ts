import { eq, sql } from "drizzle-orm";

import { onboarding } from "../db/onboarding";
import { db } from "./db";
import { keepTools } from "./onboarding";

/**
 * The table, made on first use.
 *
 * Every other table this app writes at runtime does the same (`invite`,
 * `bot_template`), and this one did not: `db:push` is a command somebody runs,
 * not part of the deploy, so on a database where it had not been run the very
 * first read threw `no such table: onboarding`. That read is awaited in the
 * root server component, so it took the whole page down for anyone signed in
 * while signed-out visitors saw the marketing page as usual: a minified
 * React #441, which is a Server Components render error with the reason
 * withheld in production.
 */
async function ensureOnboardingTable(): Promise<void> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS onboarding (
      user_id TEXT PRIMARY KEY NOT NULL,
      tools TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    )
  `);
}

/** @public */
export interface OnboardingState {
  /** The row exists: this person has been through the first run, or skipped it. */
  done: boolean;
  tools: string[];
}

/**
 * Read the stored answer, filtered again on the way out.
 *
 * The column is text this control plane wrote, so parsing it is not a trust
 * boundary; it is filtered anyway because the catalog is what the client draws
 * from and a stale id would reach the chat as a chip for a tool this build no
 * longer knows the name of.
 */
export async function readOnboarding(userId: string): Promise<OnboardingState> {
  let row: typeof onboarding.$inferSelect | undefined;
  try {
    await ensureOnboardingTable();
    [row] = await db.select().from(onboarding).where(eq(onboarding.userId, userId)).limit(1);
  } catch {
    // A database that will not answer must not stand between a person and
    // their computer. Read as done: the cost is that someone new skips the
    // first run, where the cost of the other answer is an owner stuck on it,
    // unable to reach the box, because the write cannot land either.
    return { done: true, tools: [] };
  }
  if (!row) {
    return { done: false, tools: [] };
  }
  let stored: unknown = [];
  try {
    stored = JSON.parse(row.tools);
  } catch {
    // A row written by hand, or a half-written value. The answer is lost; the
    // fact that this person is past onboarding is not, and that is the half
    // that decides which page they get.
  }
  return { done: true, tools: keepTools(stored) };
}

/** Finish the first run. Skipping is the same write with an empty answer. */
export async function completeOnboarding(userId: string, tools: unknown): Promise<string[]> {
  const kept = keepTools(tools);
  const row = { completedAt: new Date(), tools: JSON.stringify(kept) };
  await ensureOnboardingTable();
  await db
    .insert(onboarding)
    .values({ ...row, userId })
    .onConflictDoUpdate({ set: row, target: onboarding.userId });
  return kept;
}
