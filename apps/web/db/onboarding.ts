import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { user } from "./schema";

/**
 * What the first run learned, one row per user.
 *
 * The row existing is what "onboarded" means: there is no boolean to get out
 * of step with, and skipping writes the same row with an empty answer, so a
 * person who skipped is not asked again on their next device.
 *
 * `tools` is a JSON array of ids from the catalog in `lib/onboarding.ts`, and
 * it is filtered against that catalog on the way in and on the way out. It is
 * an answer to a question, not a grant: nothing here connects an account or
 * holds a credential.
 */
export const onboarding = sqliteTable("onboarding", {
  completedAt: integer("completed_at", { mode: "timestamp_ms" }).notNull(),
  tools: text("tools").notNull(),
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
});
