import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A shared Bot template and the link that opens it.
 *
 * `id` is the link, stored as itself rather than as a hash, which is the one
 * place this table differs from `invite` and is deliberate: an invite token
 * redeems to a seat on a computer, so the database must not hold anything
 * that could be replayed, while a template id opens a page that is meant to
 * be readable by whoever has the link, and the person who published it has to
 * be able to see their own link again.
 *
 * `published_at` null is a draft: the row exists, the owner can see it, and
 * the link does not resolve for anyone else. Deleting the row turns the link
 * off, which is what the share dialog promises.
 */
export const botTemplate = sqliteTable(
  "bot_template",
  {
    /** The Bot this was taken from, for the owner's own list. Never published. */
    botId: text("bot_id").notNull(),
    /** Likewise: which of the owner's computers it came from. */
    computerId: text("computer_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    /** How many Bots have been made from it. The only public number here. */
    installs: integer("installs").notNull(),
    /**
     * No foreign key, like `invite`: the table is created at runtime by
     * `CREATE TABLE IF NOT EXISTS` on a database that may not have run a
     * migration, and a constraint declared here but absent there is a claim
     * the code would then rely on.
     */
    ownerId: text("owner_id").notNull(),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    /** The document itself, as JSON. Clamped on the way in and on the way out. */
    template: text("template").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("bot_template_owner_idx").on(table.ownerId)],
);
