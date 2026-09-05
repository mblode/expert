import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Admission becomes ownership in the same row. Mirrors the first-use DDL. */
export const computerEnrollment = sqliteTable("computer_enrollment", {
  id: text("id").primaryKey(),
  hubUrl: text("hub_url").notNull().unique(),
  label: text("label").notNull(),
  setupCode: text("setup_code").notNull(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
  userId: text("user_id").unique(),
  claimedAt: integer("claimed_at"),
});
