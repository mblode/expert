import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One Fly guest (hub URL) the control plane can bind a session to. */
export const computer = sqliteTable("computer", {
  hubUrl: text("hub_url").notNull(),
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  setupCodeEnv: text("setup_code_env").notNull(),
});
