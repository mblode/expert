import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const whatsappConnection = sqliteTable("whatsapp_connection", {
  userId: text("user_id").primaryKey(),
  hubUrl: text("hub_url").notNull().unique(),
  acct: text("acct").notNull(),
  connectorId: text("connector_id").notNull(),
  connectorSecret: text("connector_secret").notNull(),
  deliveryHash: text("delivery_hash").notNull().unique(),
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  jid: text("jid").unique(),
  state: text("state").notNull().default("pending"),
});
