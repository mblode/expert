import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// Mirrored from the JSON Seat contract, as with the web's other wire types.
export interface WhatsAppConnectResponse {
  acct: string;
  jid: string;
  connector_id: string;
  connector_secret: string;
  delivery_secret: string;
}
let ready: Promise<void> | undefined;
const ensureTable = () => {
  ready ??= db
    .run(sql`CREATE TABLE IF NOT EXISTS whatsapp_connection (
    user_id TEXT PRIMARY KEY NOT NULL, hub_url TEXT NOT NULL UNIQUE,
    acct TEXT NOT NULL, connector_id TEXT NOT NULL, connector_secret TEXT NOT NULL,
    delivery_hash TEXT NOT NULL UNIQUE, code_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL, jid TEXT UNIQUE,
    state TEXT NOT NULL DEFAULT 'pending'
  )`)
    .then(() => undefined)
    .catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
  return ready;
};

interface Connection {
  user_id: string;
  hub_url: string;
  acct: string;
  connector_id: string;
  connector_secret: string;
  jid: string | null;
  state: "pending" | "binding" | "active";
  expires_at: number;
}

export async function connectionStatus(userId: string) {
  await ensureTable();
  const [row] = await db.all<Connection>(
    sql`SELECT state, jid, expires_at FROM whatsapp_connection WHERE user_id = ${userId}`,
  );
  return row
    ? {
        state: row.state,
        phone: row.jid?.split("@")[0] ?? null,
        expired: row.state === "pending" && row.expires_at <= Date.now(),
      }
    : null;
}

export async function startConnection(
  userId: string,
  hubUrl: string,
  credentials: WhatsAppConnectResponse,
) {
  await ensureTable();
  const code = randomBytes(24).toString("base64url");
  const result = await db.run(sql`INSERT INTO whatsapp_connection
    (user_id, hub_url, acct, connector_id, connector_secret, delivery_hash, code_hash, expires_at)
    VALUES (${userId}, ${hubUrl}, ${credentials.acct}, ${credentials.connector_id},
      ${credentials.connector_secret}, ${hash(credentials.delivery_secret)}, ${hash(code)}, ${Date.now() + 15 * 60_000})
    ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash,
      expires_at = excluded.expires_at, jid = NULL
    WHERE whatsapp_connection.state = 'pending' AND whatsapp_connection.hub_url = excluded.hub_url`);
  if (result.rowsAffected !== 1) throw new Error("Connection already started");
  return code;
}

/** Called only by the authenticated gateway using the transport's phone identity. */
export async function receiveConnectionCode(code: string, jid: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{32}$/u.test(code) || !/^[1-9][0-9]{7,14}@s\.whatsapp\.net$/u.test(jid))
    return false;
  await ensureTable();
  const result = await db.run(sql`UPDATE whatsapp_connection SET jid = ${jid}
    WHERE code_hash = ${hash(code)} AND state = 'pending' AND expires_at > ${Date.now()}
      AND (jid IS NULL OR jid = ${jid})
      AND NOT EXISTS (SELECT 1 FROM whatsapp_connection WHERE jid = ${jid} AND code_hash != ${hash(code)})`);
  return result.rowsAffected === 1;
}

/** Freeze the candidate before the remote write; retries reconcile this same identity. */
export async function confirmConnection(
  userId: string,
  phone: string,
  bind: (row: Connection) => Promise<void>,
) {
  await ensureTable();
  const jid = `${phone}@s.whatsapp.net`;
  await db.run(sql`UPDATE whatsapp_connection SET state = 'binding'
    WHERE user_id = ${userId} AND jid = ${jid} AND state = 'pending' AND expires_at > ${Date.now()}`);
  const [row] = await db.all<Connection>(sql`SELECT * FROM whatsapp_connection
    WHERE user_id = ${userId} AND jid = ${jid} AND state IN ('binding', 'active')`);
  if (!row) throw new Error("Send the current connection code from your WhatsApp first");
  if (row.state === "active") return;
  await bind(row);
  await db.run(
    sql`UPDATE whatsapp_connection SET state = 'active' WHERE user_id = ${userId} AND jid = ${jid} AND state = 'binding'`,
  );
}

/** Server-only routing data. Never return a connector credential to a customer. */
export async function connectionForSender(jid: string) {
  await ensureTable();
  const [row] = await db.all<Connection>(
    sql`SELECT * FROM whatsapp_connection WHERE jid = ${jid} AND state = 'active'`,
  );
  return row;
}

/** Pending identities are reserved too, so their DMs never fall back to Vibey. */
export async function reservedSender(jid: string): Promise<boolean> {
  await ensureTable();
  const rows = await db.all(sql`SELECT user_id FROM whatsapp_connection WHERE jid = ${jid}`);
  return rows.length > 0;
}

export async function deliveryRecipient(secret: string, acct: string): Promise<string | undefined> {
  if (secret.length < 32 || secret.length > 512) return undefined;
  await ensureTable();
  const [row] = await db.all<{ jid: string }>(sql`SELECT jid FROM whatsapp_connection
    WHERE delivery_hash = ${hash(secret)} AND acct = ${acct} AND state = 'active'`);
  return row?.jid;
}
