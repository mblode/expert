import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Short-lived desk or plugin link. The URL token is stored only as a hash. */
export const invite = sqliteTable(
  "invite",
  {
    computerId: text("computer_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    hubUrl: text("hub_url"),
    id: text("id").primaryKey(),
    purpose: text("purpose").notNull(),
    seatToken: text("seat_token"),
    senderHash: text("sender_hash"),
    tokenHash: text("token_hash").notNull(),
  },
  (table) => [uniqueIndex("invite_token_hash_uidx").on(table.tokenHash)],
);
