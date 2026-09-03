import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One Fly guest (hub URL) the control plane can bind a session to. */
export const computer = sqliteTable("computer", {
  hubUrl: text("hub_url").notNull(),
  id: text("id").primaryKey(),
  /**
   * The `issuer` seat this control plane holds on that hub, or null before it
   * has been bootstrapped.
   *
   * It lives beside the computer it belongs to because it is one credential
   * per computer, 1:1 with this row, and because the same database already
   * holds every seat token this control plane has been handed
   * (`computer_seat.seat_token`, `invite.seat_token`): storing one more does
   * not widen the blast radius of a database compromise, while it does remove
   * a `Pair` with an owner-minting setup code from every grant. `setup_code_env`
   * stays the name of an env var and never the code, so a row read gives an
   * attacker seats on this box and not the box.
   */
  issuerToken: text("issuer_token"),
  /** When the issuer above was minted. Diagnostics for a rotation, never auth. */
  issuerUpdatedAt: integer("issuer_updated_at", { mode: "timestamp_ms" }),
  label: text("label").notNull(),
  setupCodeEnv: text("setup_code_env").notNull(),
});
