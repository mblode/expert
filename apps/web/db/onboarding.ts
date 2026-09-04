import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  /**
   * No foreign key, like `invite` and `bot_template`: this table is created
   * at runtime by `CREATE TABLE IF NOT EXISTS` on a database that may never
   * have run a migration, and a reference declared here but absent there is a
   * claim the code would go on to rely on. It also made the first write
   * depend on `user` already existing, which is a second table's problem
   * standing in front of this one's.
   */
  userId: text("user_id").primaryKey(),
});
