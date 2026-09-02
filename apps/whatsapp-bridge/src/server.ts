import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { Logger } from "pino";

import { NotConnectedError } from "./account.ts";
import type { AccountHandle, AccountHealth, GroupSummary, LinkState } from "./account.ts";
import type { AccountConfig, AccountSummary } from "./accounts.ts";
import { parseSendMediaBody } from "./media-send.ts";

/**
 * The bridge's authenticated JSON HTTP API, loopback only.
 *
 * Two families of routes. The account routes (`/accounts…`) are what the hub's
 * `Seat.WhatsAppLink` and the hello.expert page drive: create, link by QR or
 * pairing code, list groups, join by invite, edit config, unlink. The data
 * routes (`/messages`, `/send`, …) are what a Bot's tools call back into; they
 * keep the shapes `vcmc-agent` already speaks, and take `acct` as a query
 * param (GET) or body field (POST), defaulting to the only account when there
 * is exactly one so a single-number tenant's tools need no change.
 *
 * Every request except GET /health must carry `x-bridge-secret`. The secret
 * is process-wide (the hub holds it); the per-account channel secret is a
 * different credential and only ever travels bridge -> hub.
 *
 * Group memory is NOT here: it lives next to the Bot that writes it. A write
 * route here would let anyone holding the shared secret write unbounded text
 * straight into a system prompt.
 */

// 1MB cap on POST bodies. /send-media carries a base64 image, so it gets its
// own larger cap (maxMediaBody, default 8MB) instead of this one.
const MAX_BODY = 1024 * 1024;
const DEFAULT_MAX_MEDIA_BODY = 8 * 1024 * 1024;

/** An error with the HTTP status the route should answer with. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** What the server needs from the process: account lookup and the mutations. */
export interface BridgeApi {
  health: () => AccountHealth[];
  listAccounts: () => AccountSummary[];
  /** Validates, persists and starts the socket. Throws HttpError 400/409. */
  createAccount: (body: Record<string, unknown>) => Promise<AccountSummary>;
  /** Logs the device out, deletes creds and the entry. False when unknown. */
  deleteAccount: (acct: string) => Promise<boolean>;
  link: (acct: string, phone: string | null) => Promise<LinkState>;
  linkState: (acct: string) => LinkState | undefined;
  listGroups: (acct: string) => Promise<GroupSummary[]>;
  joinGroup: (acct: string, invite: string) => Promise<string>;
  getConfig: (acct: string) => AccountConfig | undefined;
  /** Validates, persists and applies live. Throws HttpError 400. */
  setConfig: (acct: string, raw: unknown) => Promise<AccountConfig>;
  /** The data-route surface of one account, or undefined when unknown. */
  handle: (acct: string) => AccountHandle | undefined;
  accountIds: () => string[];
}

export interface StartServerArgs {
  api: BridgeApi;
  secret: string;
  host: string;
  port: number;
  logger: Logger;
  /** Body cap for POST /send-media (base64 image + envelope). Default 8MB. */
  maxMediaBody?: number;
}

/** Write a JSON response with the given status. */
const send = (res: ServerResponse, status: number, obj: unknown): ServerResponse => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  return res.end(body);
};

/**
 * Constant-time secret check. Hashing both sides to fixed-length sha256 digests
 * keeps `timingSafeEqual` from throwing on length mismatch and stops a caller
 * learning the secret's length (or matching prefix) from response timing.
 */
const secretMatches = (provided: string, expected: string): boolean => {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
};

/** Collect a request body, capped at `maxBody`, and parse it as a JSON object. */
const readJson = (
  req: IncomingMessage,
  maxBody: number = MAX_BODY,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBody) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new HttpError(400, "body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });

/** Clamp `n` from the query string into [min, max], falling back to `def`. */
const clampN = (value: unknown, def: number, min: number, max: number): number => {
  const n = Number(value ?? def);
  if (!Number.isFinite(n)) {
    return def;
  }
  return Math.min(max, Math.max(min, Math.floor(n)));
};

/** A trimmed non-empty string, or undefined, for coercing optional body fields. */
const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const errorMessage = (error: unknown): string =>
  String((error as { message?: unknown })?.message ?? error);

/**
 * Which account a legacy data route means. An explicit `acct` must exist; no
 * `acct` is fine only when there is exactly one account, because guessing
 * between two numbers would send a digest to the wrong tenant.
 */
const resolveHandle = (api: BridgeApi, acct: string | undefined | null): AccountHandle => {
  if (acct) {
    const handle = api.handle(acct);
    if (!handle) {
      throw new HttpError(404, `unknown account ${acct}`);
    }
    return handle;
  }
  const ids = api.accountIds();
  if (ids.length === 1) {
    return api.handle(ids[0]!)!;
  }
  throw new HttpError(400, ids.length === 0 ? "no accounts configured" : "acct required");
};

// ---- account routes -------------------------------------------------------

const handleAccountRoutes = async (
  req: IncomingMessage,
  url: URL,
  api: BridgeApi,
  logger: Logger,
  res: ServerResponse,
): Promise<ServerResponse | null> => {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "accounts") {
    return null;
  }
  const method = req.method ?? "GET";

  if (parts.length === 1) {
    if (method === "GET") {
      return send(res, 200, { accounts: api.listAccounts() });
    }
    if (method === "POST") {
      const created = await api.createAccount(await readJson(req));
      logger.info({ acct: created.acct, bot: created.bot }, "account created");
      return send(res, 201, { acct: created.acct });
    }
    return send(res, 405, { error: "method not allowed" });
  }

  const acct = parts[1]!;
  const sub = parts.slice(2).join("/");

  if (sub === "" && method === "DELETE") {
    if (!(await api.deleteAccount(acct))) {
      return send(res, 404, { error: `unknown account ${acct}` });
    }
    logger.info({ acct }, "account deleted");
    return send(res, 200, { deleted: true });
  }

  if (sub === "link") {
    if (method === "GET") {
      const state = api.linkState(acct);
      return state ? send(res, 200, state) : send(res, 404, { error: `unknown account ${acct}` });
    }
    if (method === "POST") {
      const body = await readJson(req);
      const phone = body.phone === undefined || body.phone === null ? null : body.phone;
      if (phone !== null && typeof phone !== "string") {
        return send(res, 400, { error: "phone must be a string of digits" });
      }
      const state = await api.link(acct, phone);
      logger.info({ acct, byCode: Boolean(phone) }, "linking started");
      return send(res, 200, state);
    }
  }

  if (sub === "groups" && method === "GET") {
    return send(res, 200, { groups: await api.listGroups(acct) });
  }

  if (sub === "groups/join" && method === "POST") {
    const body = await readJson(req);
    const invite = optionalString(body.invite);
    if (!invite) {
      return send(res, 400, { error: "invite required" });
    }
    const jid = await api.joinGroup(acct, invite);
    logger.info({ acct, jid }, "joined group by invite");
    return send(res, 200, { jid });
  }

  if (sub === "config") {
    if (method === "GET") {
      const config = api.getConfig(acct);
      return config
        ? send(res, 200, { config })
        : send(res, 404, { error: `unknown account ${acct}` });
    }
    if (method === "PUT") {
      const body = await readJson(req);
      const config = await api.setConfig(acct, body.config);
      logger.info({ acct }, "account config updated");
      return send(res, 200, { config });
    }
  }

  return send(res, 404, { error: "not found" });
};

// ---- legacy data routes ---------------------------------------------------

/** GET routes that return a list of records (messages, resources, reactions, members). */
const handleGetRecords = async (
  url: URL,
  api: BridgeApi,
  res: ServerResponse,
): Promise<ServerResponse | null> => {
  const { pathname } = url;
  if (!["/messages", "/resources", "/members", "/reactions", "/export"].includes(pathname)) {
    return null;
  }
  const handle = resolveHandle(api, url.searchParams.get("acct"));
  const { store } = handle;
  const group = url.searchParams.get("group");

  if (pathname === "/members") {
    return send(res, 200, handle.getMembers());
  }
  if (!group) {
    return send(res, 400, { error: "group required" });
  }
  if (pathname === "/messages") {
    const n = clampN(url.searchParams.get("n"), 150, 1, 2000);
    return send(res, 200, { messages: await store.recentMessages(group, n) });
  }
  if (pathname === "/resources") {
    const n = clampN(url.searchParams.get("n"), 40, 1, 200);
    return send(res, 200, { resources: await store.recentResources(group, n) });
  }
  if (pathname === "/reactions") {
    const n = clampN(url.searchParams.get("n"), 200, 1, 5000);
    return send(res, 200, { reactions: await store.recentReactions(group, n) });
  }
  // Full stored history for a group (no recent-window cap), so an offline
  // reingest can bake backfilled deep history into a tenant's archive.
  return send(res, 200, { messages: await store.allMessages(group) });
};

/** POST /backfill: ask WhatsApp for older history in a group. */
const handleBackfill = async (
  body: Record<string, unknown>,
  handle: AccountHandle,
  logger: Logger,
  res: ServerResponse,
): Promise<ServerResponse> => {
  const group = optionalString(body.group);
  if (!group) {
    return send(res, 400, { error: "group required" });
  }
  const n = clampN(body.n, 200, 1, 2000);
  try {
    const result = await handle.onBackfill(group, n);
    logger.info({ acct: handle.acct, group, n }, "history backfill requested");
    return send(res, 200, { ok: true, ...result });
  } catch (error) {
    return send(res, 409, { error: errorMessage(error) });
  }
};

/** POST /report: forward a feature request or bug report to the maintainer. */
const handleReport = async (
  body: Record<string, unknown>,
  handle: AccountHandle,
  logger: Logger,
  res: ServerResponse,
): Promise<ServerResponse> => {
  const summary = optionalString(body.summary);
  if (!summary) {
    return send(res, 400, { error: "summary required" });
  }
  const kind = body.kind === "bug" ? "bug" : "feature";
  try {
    const result = await handle.onReport({
      details: optionalString(body.details),
      kind,
      requestedBy: optionalString(body.requestedBy),
      summary,
    });
    logger.info(
      { acct: handle.acct, delivered: result.delivered, kind },
      "feature report received",
    );
    return send(res, 200, result);
  } catch (error) {
    return send(res, 502, { error: errorMessage(error) });
  }
};

/** POST /invite: forward a member invite / referral to the maintainer. */
const handleInvite = async (
  body: Record<string, unknown>,
  handle: AccountHandle,
  logger: Logger,
  res: ServerResponse,
): Promise<ServerResponse> => {
  const fullName = optionalString(body.fullName);
  const phone = optionalString(body.phone);
  if (!(fullName && phone)) {
    return send(res, 400, { error: "fullName and phone required" });
  }
  const source = body.source === "contact-card" ? "contact-card" : "form";
  try {
    const result = await handle.onInvite({
      email: optionalString(body.email),
      fullName,
      linkedIn: optionalString(body.linkedIn),
      note: optionalString(body.note),
      phone,
      requestedBy: optionalString(body.requestedBy),
      source,
    });
    logger.info(
      { acct: handle.acct, delivered: result.delivered, source },
      "member invite received",
    );
    return send(res, 200, result);
  } catch (error) {
    return send(res, 502, { error: errorMessage(error) });
  }
};

/**
 * POST /send: deliver a proactive message (e.g. the daily digest) to an
 * allowlisted DM. The target allowlist is enforced by the account's onSend,
 * not here; the group refusal is here, in code, on purpose.
 */
const handleSend = async (
  body: Record<string, unknown>,
  handle: AccountHandle,
  logger: Logger,
  res: ServerResponse,
): Promise<ServerResponse> => {
  const jid = optionalString(body.jid);
  const text = optionalString(body.text);
  // Optional: an eve turn is a durable workflow whose steps replay. A key lets
  // a replayed step collapse onto the original send instead of texting twice.
  const idempotencyKey = optionalString(body.idempotencyKey);
  if (!(jid && text)) {
    return send(res, 400, { error: "jid and text required" });
  }
  // A Bot never posts to a group on its own initiative: schedules and the
  // overnight passes only ever DM. Refuse group JIDs structurally here rather
  // than leaning on the onSend allowlist: that allowlist is config
  // (owner_jids / digest_recipient_jids), so it fails open the day a group JID
  // lands in either by mistake. This is the invariant, so it lives in code.
  // /send-media deliberately does the opposite and permits groups: a requested
  // image into the chat is a reply, not an unprompted broadcast.
  if (jid.endsWith("@g.us")) {
    logger.warn({ acct: handle.acct, jid }, "refusing proactive send to a group jid");
    return send(res, 403, { error: "proactive sends to groups are not allowed" });
  }
  try {
    const result = await handle.onSend(jid, text, idempotencyKey);
    if (!result.sent) {
      return send(res, 403, { error: "jid not allowlisted for sends" });
    }
    logger.info({ acct: handle.acct, jid }, "proactive message sent");
    return send(res, 200, result);
  } catch (error) {
    return send(res, 502, { error: errorMessage(error) });
  }
};

/** POST /send-media: deliver a proactive image into an allowlisted chat. */
const handleSendMedia = async (
  body: Record<string, unknown>,
  handle: AccountHandle,
  logger: Logger,
  res: ServerResponse,
): Promise<ServerResponse> => {
  const parsed = parseSendMediaBody(body);
  if ("error" in parsed) {
    return send(res, 400, { error: parsed.error });
  }
  try {
    const result = await handle.onSendMedia(parsed.payload);
    if (!result.sent) {
      return send(res, 403, { error: result.reason ?? "jid not allowlisted for sends" });
    }
    logger.info({ acct: handle.acct, jid: parsed.payload.jid }, "proactive media sent");
    return send(res, 200, { sent: true });
  } catch (error) {
    return send(res, 502, { error: errorMessage(error) });
  }
};

const LEGACY_POSTS = new Set(["/backfill", "/report", "/invite", "/send", "/send-media"]);

const handleLegacyPost = async (
  req: IncomingMessage,
  url: URL,
  api: BridgeApi,
  logger: Logger,
  maxMediaBody: number,
  res: ServerResponse,
): Promise<ServerResponse | null> => {
  const { pathname } = url;
  if (req.method !== "POST" || !LEGACY_POSTS.has(pathname)) {
    return null;
  }
  // The body carries `acct`, so it is read before the account is resolved.
  const body = await readJson(req, pathname === "/send-media" ? maxMediaBody : MAX_BODY);
  const handle = resolveHandle(api, optionalString(body.acct));
  switch (pathname) {
    case "/backfill": {
      return handleBackfill(body, handle, logger, res);
    }
    case "/report": {
      return handleReport(body, handle, logger, res);
    }
    case "/invite": {
      return handleInvite(body, handle, logger, res);
    }
    case "/send": {
      return handleSend(body, handle, logger, res);
    }
    default: {
      return handleSendMedia(body, handle, logger, res);
    }
  }
};

/** Start the bridge HTTP API. Resolves once listening. */
export const startServer = ({
  api,
  secret,
  host,
  port,
  logger,
  maxMediaBody = DEFAULT_MAX_MEDIA_BODY,
}: StartServerArgs): Server => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "", "http://localhost");
    try {
      // Health is unauthenticated so the hub supervisor's probe needs no
      // secret. Always 200 (process liveness): a socket still pairing is not
      // a dead process, and each account's socket state is in the body.
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { accounts: api.health(), ok: true });
      }

      if (!secret) {
        return send(res, 503, { error: "bridge secret not configured" });
      }
      const headerSecret = req.headers["x-bridge-secret"];
      const provided = Array.isArray(headerSecret) ? (headerSecret[0] ?? "") : (headerSecret ?? "");
      if (!secretMatches(provided, secret)) {
        return send(res, 401, { error: "unauthorized" });
      }

      logger.debug({ method: req.method, path: url.pathname }, "bridge api request");

      const accountResult = await handleAccountRoutes(req, url, api, logger, res);
      if (accountResult !== null) {
        return accountResult;
      }
      if (req.method === "GET") {
        const recordsResult = await handleGetRecords(url, api, res);
        if (recordsResult !== null) {
          return recordsResult;
        }
      }
      const postResult = await handleLegacyPost(req, url, api, logger, maxMediaBody, res);
      if (postResult !== null) {
        return postResult;
      }
      return send(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof HttpError) {
        return send(res, error.status, { error: error.message });
      }
      if (error instanceof NotConnectedError) {
        return send(res, 503, { error: error.message });
      }
      logger.error({ error, method: req.method, path: url.pathname }, "bridge api error");
      return send(res, 500, { error: errorMessage(error) });
    }
  });

  server.listen(port, host);
  return server;
};
