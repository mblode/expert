import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { computer } from "./computer";
import { user } from "./schema";

/** One hub seat token per signed-in user, bound to a computer in the catalog. */
export const computerSeat = sqliteTable("computer_seat", {
  computerId: text("computer_id")
    .notNull()
    .references(() => computer.id, { onDelete: "restrict" }),
  hubUrl: text("hub_url").notNull(),
  seatToken: text("seat_token").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
});
