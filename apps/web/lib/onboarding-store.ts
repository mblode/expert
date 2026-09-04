import { eq } from "drizzle-orm";

import { onboarding } from "../db/onboarding";
import { db } from "./db";
import { keepTools } from "./onboarding";

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
  const row = { completedAt: new Date(), tools: JSON.stringify(kept) };
  await db
    .insert(onboarding)
    .values({ ...row, userId })
    .onConflictDoUpdate({ set: row, target: onboarding.userId });
  return kept;
}
