import { eq, sql } from "drizzle-orm";

import { onboarding } from "../db/onboarding";
import { db } from "./db";
import { keepTools } from "./onboarding";

/**
 * Create the table on first use, the way `invite-store.ts` does.
 *
 * There is no migration step in this deployment: nothing runs `drizzle-kit`
 * against Turso, so a table declared in `db/` exists only if some code makes
 * it. This one did not, and the first signed-in render after it shipped threw
 * `no such table: onboarding` inside a Server Component, which reaches the
 * browser as a bare "Something broke" with the message stripped. The marketing
 * page kept rendering, so the site looked up while every account was locked
 * out of it.
 *
 * Memoised per warm instance, and the promise is dropped on failure so the
 * next request retries rather than inheriting a rejection forever.
 */
let onboardingTableReady: Promise<void> | undefined;

function ensureOnboardingTable(): Promise<void> {
  onboardingTableReady ??= createOnboardingTable().catch((error: unknown) => {
    onboardingTableReady = undefined;
    throw error;
  });
  return onboardingTableReady;
}

async function createOnboardingTable(): Promise<void> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS onboarding (
      user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      completed_at INTEGER NOT NULL,
      tools TEXT NOT NULL
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
  await ensureOnboardingTable();
  const [row] = await db.select().from(onboarding).where(eq(onboarding.userId, userId)).limit(1);
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
  await ensureOnboardingTable();
  const row = { completedAt: new Date(), tools: JSON.stringify(kept) };
  await db
    .insert(onboarding)
    .values({ ...row, userId })
    .onConflictDoUpdate({ set: row, target: onboarding.userId });
  return kept;
}
