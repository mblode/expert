import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { user } from "./schema";

/** One hub seat token per signed-in user. The web server Pairs; the client never sees the setup code. */
export const computerSeat = sqliteTable("computer_seat", {
  hubUrl: text("hub_url").notNull(),
  seatToken: text("seat_token").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
});
