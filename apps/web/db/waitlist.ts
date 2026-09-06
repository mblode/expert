import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Who asked for a computer and was not on the list, one row per email.
 *
 * Sign-up is gated: an email that is neither in `AUTH_ALLOWED_EMAILS` nor
 * holding a computer invitation cannot make an account, and before this it
 * simply never received its code. Now that attempt is the request. The row
 * is the record; Resend holds the same address as a contact so the person can
 * be written to when a computer is ready. No credential, no seat, nothing a
 * row here can open.
 */
export const waitlist = sqliteTable("waitlist", {
  email: text("email").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  /** Where the request came from: `login`, `marketing`, ... */
  source: text("source").notNull(),
  /** When the confirmation went out through Resend; null if it did not. */
  notifiedAt: integer("notified_at", { mode: "timestamp_ms" }),
});
