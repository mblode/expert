// ARCHITECTURE: one of these per linked number. It owns that account's Baileys
// socket, its stores under `<data>/<acct>/`, its creds under `<state>/<acct>/auth`,
// and the whole inbound pipeline (classify, record, trigger, attachments, ask
// the hub, reply). Nothing in here reads env or touches another account: the
// process-wide knobs arrive in `deps.env`, and the per-account settings are
// read off `record.config` on every use so a PUT to the config route applies
// without a restart. Two cohesive slices remain the seams to extract if this
// keeps growing: the media-ingestion pipeline (download + caps + envelope) and
// the connection lifecycle (start / reconnect / link / logout).
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import type {
  BaileysEventMap,
  ConnectionState,
  GroupMetadata,
  proto,
  WAMessage,
  WAMessageKey,
  WAMessageUpdate,
  WASocket,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";

import { authDir } from "./accounts.ts";
import type { AccountConfig, AccountRecord, AccountSummary, LinkStatus } from "./accounts.ts";
import { createCacheStore, createSentStore } from "./baileys-cache.ts";
import { boundedMap, boundedSet } from "./bounded-set.ts";
import {
  categorizeDocument,
  extractDocumentText,
  formatDocumentContext,
  pdfPageCount,
} from "./document.ts";
import type { BridgeEnv } from "./env.ts";
import { allGroups, groupAllowed, listedGroups } from "./groups.ts";
import type { GroupGate } from "./groups.ts";
import { createChannelClient } from "./hub-client.ts";
import type { AgentReply, Media } from "./hub-client.ts";
import { buildInviteMessage, inviteDedupKey } from "./invite.ts";
import type { InviteRequest } from "./invite.ts";
import { createJidQueue } from "./jid-queue.ts";
import {
  createLiveRoster,
  excludeIds,
  formatMemberContext,
  mergeWithOverlay,
  parseParticipants,
  participantsFrom,
  phoneDigits,
} from "./live-members.ts";
import type { LiveMember } from "./live-members.ts";
import { createDailyCounter, sendTargetAllowed } from "./media-send.ts";
import type { SendMediaPayload, SendTargetGate } from "./media-send.ts";
import { createMessageIndex } from "./message-ids.ts";
import { loadMembersOverlay } from "./members.ts";
import type { Member } from "./members.ts";
import {
  composeMentionLookup,
  lidPairsFrom,
  memberNameLookup,
  resolveMentions,
} from "./mentions.ts";
import type { NameLookup } from "./mentions.ts";
import {
  audioContent,
  classifyMessage,
  documentContent,
  extractText,
  mediaPlaceholder,
  messageText,
  messageTs,
  phoneNumberJid,
  quotedImageSource,
  quotedText,
  resolveSenderInfo,
} from "./message-parse.ts";
import { isOwner, parseOwnerIds } from "./owner.ts";
import { authoriseEnvelope } from "./send-envelope.ts";
import type { EnvelopeMedia, SendEnvelope } from "./send-envelope.ts";
import { buildReportMessage, reportDedupKey } from "./report.ts";
import type { FeatureReport } from "./report.ts";
import { shouldReply } from "./routing.ts";
import { createStore, extractUrls } from "./store.ts";
import type { Anchors, LidEntry, LidMap, MessageRecord, Store } from "./store.ts";
import { transcribeAudio } from "./transcribe.ts";
import {
  extractEdit,
  getContextInfo,
  mentionsBot,
  mentionsBotByName,
  shouldReplyToEdit,
  stripBotMention,
  triggerText,
  userPart,
} from "./trigger.ts";
import type { Bot } from "./trigger.ts";
import { bindEvents } from "./wa-events.ts";
import { resolveWaVersion } from "./wa-version.ts";
import { createWhitelist } from "./whitelist.ts";

/** Live socket state for GET /health. */
export interface AccountHealth {
  acct: string;
  /** "unlinked" = no registered creds; otherwise the socket's own state. */
  whatsapp: "open" | "connecting" | "close" | "unlinked";
  lastCloseCode: number | null;
  failingSince: string | null;
  attempts: number;
}

/** Pairing state for GET /accounts/:acct/link. */
export interface LinkState {
  acct: string;
  status: LinkStatus;
  /** Raw Baileys QR string, held only while linking without a phone. */
  qr: string | null;
  /** The 8-character code from requestPairingCode, held only while linking with a phone. */
  pairing_code: string | null;
  /** Milliseconds since the QR or code was issued; WhatsApp rotates QRs every 20-60s. */
  age_ms: number | null;
  phone: string | null;
}

export interface GroupSummary {
  jid: string;
  subject: string;
  size: number;
  /** Whether the allowlist admits it (an empty allowlist admits every group). */
  enabled: boolean;
}

/** Thrown by the routes that need a live socket; the server maps it to 503. */
export class NotConnectedError extends Error {
  constructor() {
    super("WhatsApp socket not connected");
    this.name = "NotConnectedError";
  }
}

/**
 * The slice of an account the legacy data routes need. Kept as an interface so
 * `server.ts` tests can hand in a fake without booting Baileys.
 */
export interface AccountHandle {
  acct: string;
  store: Store;
  getMembers: () => { members: LiveMember[]; ready: boolean };
  onBackfill: (group: string, n: number) => Promise<{ anchor: string; requested: number }>;
  onReport: (report: FeatureReport) => Promise<{ delivered: boolean; duplicate?: boolean }>;
  onInvite: (invite: InviteRequest) => Promise<{ delivered: boolean; duplicate?: boolean }>;
  onSend: (
    jid: string,
    text: string,
    idempotencyKey?: string,
  ) => Promise<{ sent: boolean; deduped?: boolean }>;
  onSendMedia: (payload: SendMediaPayload) => Promise<{ sent: boolean; reason?: string }>;
  /** The one outbound envelope: quoted reply, reaction, text, image, document. */
  onSendEnvelope: (
    envelope: SendEnvelope,
  ) => Promise<{ sent: boolean; reason?: string; messageIds?: string[] }>;
}

export interface AccountRuntime {
  acct: string;
  record: () => AccountRecord;
  health: () => AccountHealth;
  linkState: () => LinkState;
  summary: () => AccountSummary;
  handle: AccountHandle;
  /** Load persisted state and open the socket. Safe to call once. */
  start: () => Promise<void>;
  /** Drain in-flight work, flush state, drop the socket without unlinking. */
  stop: () => Promise<void>;
  /** Log the device out, delete its creds, stop. The data store stays. */
  destroy: () => Promise<void>;
  /** (Re)start linking: by pairing code when a phone is given, else by QR. */
  link: (phone: string | null) => Promise<LinkState>;
  listGroups: () => Promise<GroupSummary[]>;
  joinGroup: (invite: string) => Promise<string>;
  /** Swap in a new record (config or phone) and apply what changed, live. */
  applyRecord: (next: AccountRecord) => Promise<void>;
}

export interface AccountRuntimeDeps {
  record: AccountRecord;
  env: BridgeEnv;
  logger: Logger;
  /** Gateway transcription model id, or null when voice notes stay as [audio]. */
  transcribeModel: string | null;
  /** Called when the socket learns the linked number, so the registry can persist it. */
  onPhone: (phone: string) => Promise<void>;
  /** Test seam for the Baileys socket factory and version lookup. */
  sleep?: (ms: number) => Promise<void>;
}

// Consecutive closes carrying the same code before we escalate from "warn, will
// retry" to "error, something is structurally wrong". A code that never changes
// is not a transient blip: the 405 outage repeated identically for hours.
const STUCK_AFTER_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 5 * 60_000;
// An unregistered socket closes every minute or so once WhatsApp stops issuing
// QRs. Reconnect a few times so a slow scan still lands, then stop and wait for
// POST /link, or an account nobody ever pairs would churn against WhatsApp
// forever.
const LINK_MAX_ATTEMPTS = 5;
const LID_CAP = 5000;
const PROCESSED_CAP = 1000;
const REPLIED_CAP = 1000;
const REPORTED_CAP = 200;
const SENT_KEY_CAP = 500;
// Short message ids the Bot may quote or react to. Two thousand covers a busy
// group's last day or two; past that an id falls off and the envelope refuses,
// which is the trade this index is bounded for.
const MESSAGE_INDEX_CAP = 2000;

/** Parse a chat.whatsapp.com link or a bare invite code. */
export const inviteCodeFrom = (invite: string): string | null => {
  const trimmed = invite.trim();
  if (!trimmed) {
    return null;
  }
  const match = /(?:chat\.whatsapp\.com\/(?:invite\/)?)?([A-Za-z0-9_-]{6,})\/?$/u.exec(trimmed);
  return match?.[1] ?? null;
};

/**
 * A closed connection's error carries the status code Baileys uses to decide
 * whether we were logged out. Baileys wraps it in a Boom error (`.output.statusCode`);
 * we name the shape locally rather than depend on @hapi/boom directly.
 */
type DisconnectError = Error & { output?: { statusCode?: number } };

/** What a downloaded document turns into for the Bot. */
type DocResult =
  // A PDF, handed to the model as a native file part (like an image).
  | { kind: "media"; media: Media }
  // Text we extracted, to ride in as an untrusted context block.
  | { kind: "text"; text: string };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Build a "conversation so far" context block from the recent message buffer,
 * so the Bot (which runs a fresh, memory-less session per message) can see
 * what was just said in this thread without us reintroducing the stale-reply
 * bug (that lived in the continuation token, not here).
 *
 * `records` are store rows oldest->newest. The LAST row is the current inbound
 * message (recorded before this runs) and is sent separately as `message`, so
 * we drop it to avoid duplicating it. Each remaining row becomes a `Name: text`
 * line; the bot's own lines (role "assistant") are labelled with the bot name.
 * Returns null when there's nothing useful to show.
 */
export const buildConversationContext = (
  records: MessageRecord[],
  { surface, botName, lookup }: { surface?: string; botName: string; lookup: NameLookup },
): string | null => {
  if (records.length < 2) {
    return null;
  }
  // Drop the last row: it's the current message, already sent as `message`.
  const prior = records.slice(0, -1);
  const lines: string[] = [];
  for (const r of prior) {
    const raw = typeof r.x === "string" ? r.x.trim() : "";
    if (!raw) {
      continue;
    }
    const text = raw.length > 300 ? `${raw.slice(0, 300)}...` : raw;
    // Rows stored before name resolution existed carry only the raw lid digits
    // in `s`: run those through the lookup so the model gets a real name to
    // attribute to (a digits label invites misattribution to names that merely
    // appear inside other people's messages).
    const who = r.role === "assistant" ? botName : r.n || lookup(r.s) || r.s || "someone";
    lines.push(`${who}: ${text}`);
  }
  if (lines.length === 0) {
    return null;
  }
  // The store records every group message (before any reply gating), so this
  // tail is the real recent conversation: say so, so the model trusts it when
  // resolving references like "this" or "the link above".
  const header =
    surface === "dm"
      ? "Recent conversation (most recent last), for context only:"
      : "Recent group conversation (most recent last), for context only:";
  return `${header}\n${lines.join("\n")}`;
};

/**
 * A neutral anchor when an attachment arrives with no caption, so the Bot has
 * something to reply to. Empty string when there's no attachment.
 */
const noCaptionNote = (media: Media[] | undefined, docContext: string[] | undefined): string => {
  if (media?.length) {
    return "(media shared with no caption)";
  }
  if (docContext?.length) {
    return "(document shared with no caption)";
  }
  return "";
};

/** Resolve a unix-second timestamp from a reaction's senderTimestampMs (ms). */
const resolveReactionTs = (senderTimestampMs: proto.IReaction["senderTimestampMs"]): number => {
  const ms = Number(senderTimestampMs);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
};

export const createAccountRuntime = (deps: AccountRuntimeDeps): AccountRuntime => {
  const { env } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  let { record } = deps;
  const { acct } = record;
  const logger = deps.logger.child({ acct });
  const cfg = (): AccountConfig => record.config;
  const botName = (): string => cfg().bot_name;

  // Derived from config; rebuilt by applyRecord so a PUT applies live.
  const gateFrom = (config: AccountConfig): GroupGate =>
    config.group_policy === "listed" ? listedGroups(config.allowed_groups) : allGroups;
  let groupGate = gateFrom(cfg());
  let owners = parseOwnerIds(cfg().owner_jids.join(","));
  let digestRecipients = parseOwnerIds(cfg().digest_recipient_jids.join(","));
  let dmAllowlist = parseOwnerIds(cfg().dm_allowlist.join(","));
  let overlay: Member[] = [];
  const isAllowedGroup = (jid: string): boolean => groupAllowed(groupGate, jid);

  const store = createStore(path.join(env.dataDir, acct), {
    messagesCap: env.messagesCap,
    reactionsCap: env.reactionsCap,
  });
  // Live WhatsApp participant set (volume-backed). The `members` DM policy and
  // the merged roster the Bot reads both come from this, not from the overlay.
  const live = createLiveRoster();
  const whitelist = createWhitelist(logger, {
    lids: () => live.lids(),
    phones: () => live.phones(),
    ready: () => live.ready(),
  });
  // Serialize per-chat message handling so two messages in one chat are answered
  // in the order they arrived rather than racing each other's presence updates
  // and store writes.
  const chatQueue = createJidQueue();
  // Recently sent messages + retry counters, so Baileys can answer a recipient's
  // decryption-retry receipts (otherwise the recipient is stuck on "Waiting for
  // this message"). In-memory: retry receipts arrive within seconds of the send.
  const sentStore = createSentStore();
  const msgRetryCounterCache = createCacheStore();

  // Live connection state, surfaced on GET /health. The extra fields exist
  // because a bridge that cannot reach WhatsApp silently swallows every
  // message: WhatsApp still ticks the sender's message, it just never reaches
  // us. That failed invisibly for hours once. /health is the out-of-band signal
  // for it; the in-band one (a DM to the maintainer) needs the very socket
  // that is down.
  let conn: "connecting" | "open" | "close" = "connecting";
  let registered = false;
  let lastCloseCode: number | null = null;
  let failingSince: string | null = null;
  let closeAttempts = 0;
  let displayName: string | undefined;

  let currentSock: WASocket | null = null;
  let stopped = false;
  let inFlight = 0;
  // Consecutive failed reconnects, reset once a connection actually opens. Drives
  // the backoff: WhatsApp rejects some logins with a code Baileys does not
  // classify as loggedOut (405 "Connection Failure" is the one seen in prod), and
  // retrying that instantly means hammering WhatsApp every few seconds forever,
  // which risks turning a transient refusal into a longer block on the number.
  let reconnectAttempts = 0;
  // Linking state. The QR and the pairing code are credentials (whoever uses
  // one links their own device to this number), so they are held in memory
  // only, served solely on the authenticated link route, and cleared the
  // moment the socket opens. `pairingPhone` picks the code path over the QR.
  let latestQr: { qr: string; at: number } | null = null;
  let pairingCode: { code: string; at: number } | null = null;
  let pairingPhone: string | null = null;
  let linking = false;
  let linkAttempts = 0;

  // Oldest-known message per group (id + ts): the anchor for on-demand backfill.
  const anchors: Anchors = {};
  let anchorsDirty = false;
  // What we've learned about each WhatsApp @lid: the phone it pairs with (modern
  // WA addresses mentions and senders by opaque @lid, while the member roster is
  // keyed by phone, so a lid mention only resolves to a name through this map)
  // and the last pushName we saw for it. Learned from every message (which carries
  // both ids), and PERSISTED: without that, a restart drops the map and the
  // first mention after it comes through as raw digits.
  const lidMap = boundedMap<LidEntry>(LID_CAP);
  let lidDirty = false;
  // Message ids already backfilled this process, so a re-sync doesn't re-store.
  const historySeen = boundedSet(100_000);
  // Recently processed message ids. WhatsApp can redeliver, and the retry path
  // means a single id must only ever be processed once. Seeded from disk on
  // boot and flushed back, so a restart doesn't re-reply to redelivered messages.
  const processedIds = boundedSet(PROCESSED_CAP);
  let processedDirty = 0;
  // Message ids we've already replied to (a fresh @-mention OR an edited-in
  // mention), so an edit of an already-answered message can't double-reply.
  const repliedIds = boundedSet(REPLIED_CAP);
  // Forwarded report / invite keys, so the same request doesn't DM the
  // maintainer twice. In-memory: a short window is enough.
  const reportedKeys = boundedSet(REPORTED_CAP);
  const invitedKeys = boundedSet(REPORTED_CAP);
  // Idempotency keys already delivered via POST /send. An eve turn is a durable
  // workflow whose steps replay after an interruption; without this, a replay
  // is a duplicate WhatsApp message.
  const sentKeys = boundedSet(SENT_KEY_CAP);
  const mediaSendCounter = createDailyCounter(() => cfg().image_sends_per_day);
  // Every outbound envelope costs one write, whatever verb it carries: a
  // reaction is cheap to send and still a write into someone's group.
  const envelopeWriteCounter = createDailyCounter(() => cfg().sends_per_day);
  // Short id -> Baileys key, so a Bot can quote or react to a message it was
  // shown without ever handling a raw WhatsApp key. Bounded; see message-ids.ts.
  const messageIndex = createMessageIndex(MESSAGE_INDEX_CAP);

  const askAgent = createChannelClient({
    acct,
    channelSecret: record.channel_secret,
    endpoint: `${env.computerUrl}/channels/${record.channel_id}/message`,
    logger,
    sleep,
    timeoutMs: env.agentTimeoutMs,
  });

  /** Download a message's media to a buffer, with the standard reupload options. */
  const downloadBuffer = (sock: WASocket, msg: WAMessage): Promise<Buffer> =>
    downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });

  /**
   * Send a text message and remember it: `sentStore` so decryption-retry
   * receipts can be answered, and the message index so the Bot can quote or
   * react to its own message afterwards. `quoted` makes it a threaded reply.
   */
  const sendText = async (
    sock: WASocket,
    jid: string,
    text: string,
    quoted?: WAMessage,
  ): Promise<WAMessage | undefined> => {
    const sent = await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
    sentStore.record(sent);
    messageIndex.remember(sent?.key, text);
    return sent;
  };

  /**
   * Best-effort typing indicator: presence is cosmetic, so a failed update logs
   * and never throws into the reply path (it used to abort the whole turn).
   */
  const setPresence = async (
    sock: WASocket,
    jid: string,
    presence: "composing" | "paused",
  ): Promise<void> => {
    try {
      await sock.sendPresenceUpdate(presence, jid);
    } catch (presenceError) {
      logger.warn({ err: presenceError, jid, presence }, "presence update failed");
    }
  };

  const requireSock = (): WASocket => {
    if (!currentSock || conn !== "open") {
      throw new NotConnectedError();
    }
    return currentSock;
  };

  // ---- persistence -------------------------------------------------------

  const lidMapSnapshot = (): LidMap => {
    const obj: LidMap = {};
    for (const [k, v] of lidMap.entries()) {
      obj[k] = v;
    }
    return obj;
  };

  /** Persist the lid map when dirty (best-effort; re-arms the flag on failure). */
  const flushLidMap = async (): Promise<void> => {
    if (!lidDirty) {
      return;
    }
    lidDirty = false;
    try {
      await store.saveLidMap(lidMapSnapshot());
    } catch (error) {
      lidDirty = true;
      logger.warn({ error }, "failed to persist lid map");
    }
  };

  /** Persist the live participant set when dirty (same durability as the lid map). */
  const flushLive = async (): Promise<void> => {
    if (!live.dirty()) {
      return;
    }
    live.clearDirty();
    try {
      await store.saveParticipants(live.snapshot());
    } catch (error) {
      live.markDirty();
      logger.warn({ error }, "failed to persist live participants");
    }
  };

  const flushProcessed = async (): Promise<void> => {
    processedDirty = 0;
    try {
      await store.saveProcessedIds([...processedIds.values()]);
    } catch (error) {
      logger.warn({ error }, "failed to persist processed ids");
    }
  };

  const flushAnchors = async (): Promise<void> => {
    if (!anchorsDirty) {
      return;
    }
    anchorsDirty = false;
    try {
      await store.saveAnchors(anchors);
    } catch (error) {
      anchorsDirty = true;
      logger.warn({ error }, "failed to persist anchors");
    }
  };

  const markProcessed = (id: string): void => {
    processedIds.add(id);
    // Debounce persistence: flush every 10 marks; the timer catches the rest.
    processedDirty += 1;
    if (processedDirty >= 10) {
      void flushProcessed();
    }
  };

  const markReplied = (id: string | null | undefined): void => {
    if (id) {
      repliedIds.add(id);
    }
  };

  // Periodic flush of processed ids, anchors, lid map and live set. unref so it
  // never holds the process open during shutdown.
  const flushTimer = setInterval(async () => {
    if (processedDirty) {
      await flushProcessed();
    }
    await flushAnchors();
    await flushLidMap();
    await flushLive();
  }, 15_000);
  flushTimer.unref();

  // ---- identity and name resolution -------------------------------------

  // Learn a sender's lid->phone->name pairing into the persisted lidMap, so a
  // later @mention of them resolves to a name.
  const rememberLid = (user: string, phone?: string | null, name?: string | null): void => {
    const p = phone?.trim() || undefined;
    const n = name?.trim() || undefined;
    if (!user || (!p && !n)) {
      return;
    }
    const cur = lidMap.get(user);
    // Merge so a name-only update keeps a known phone (and vice versa).
    const next: LidEntry = { name: n ?? cur?.name, phone: p ?? cur?.phone };
    if (cur && cur.name === next.name && cur.phone === next.phone) {
      return;
    }
    lidMap.set(user, next);
    lidDirty = true;
  };
  // Learn a name when there's no phone in hand (history sync, reaction reactors).
  const rememberName = (user: string, name: string | undefined | null): void => {
    rememberLid(user, undefined, name);
  };

  const roster = (): LiveMember[] => mergeWithOverlay(live.all(), overlay);

  // Mention-token name resolution (see composeMentionLookup in mentions.ts): the
  // bot's own ids -> its name (the trigger path then strips that token), then the
  // live+overlay roster (by phone or learned lid->phone), then the pushName
  // seen for that lid. Rebuilt each call so a joiner resolves before the
  // overlay is updated.
  const mentionLookupFor = (bot: Bot | null): NameLookup =>
    composeMentionLookup({
      botIds: bot ? new Set([bot.number, bot.lid].filter((v): v is string => Boolean(v))) : null,
      botName: botName(),
      lidName: (user) => lidMap.get(user)?.name,
      lidPhone: (user) => lidMap.get(user)?.phone,
      roster: memberNameLookup(roster()),
    });

  /** The bot's own phone/lid digits, so it is never stored as a group member. */
  const botIdsFrom = (sock: WASocket): Set<string> => {
    const ids = new Set<string>();
    const phone = phoneDigits(userPart(sock.user?.id ?? ""));
    const lid = userPart(sock.user?.lid ?? "");
    if (phone) {
      ids.add(phone);
    }
    if (lid) {
      ids.add(lid);
    }
    return ids;
  };

  /** The bot's identity from the live socket (phone number + @lid) plus its name. */
  const getBot = (sock: WASocket): Bot => ({
    lid: userPart(sock.user?.lid ?? "") || null,
    name: botName(),
    number: userPart(sock.user?.id ?? ""),
  });

  // ---- group seeding -----------------------------------------------------

  /** Learn one group's participants (lid pairs + live set) from its metadata. */
  const learnGroup = (sock: WASocket, jid: string, meta: Partial<GroupMetadata>): number => {
    const people = participantsFrom(meta.participants);
    let pairs = 0;
    for (const pair of lidPairsFrom(meta.participants)) {
      rememberLid(pair.lid, pair.phone, pair.name);
      pairs += 1;
    }
    live.replaceGroup(jid, excludeIds(people, botIdsFrom(sock)));
    live.markSeeded();
    return pairs;
  };

  // Seed the lid map from group metadata, so a mention of a member resolves even
  // when they haven't spoken since the process started. Passive learning alone
  // left exactly that gap: right after a deploy the map only knows people who
  // have since sent a message. Group participants carry both ids (lid + phone),
  // and one IQ fetches every group. Groups outside the allowlist are dropped
  // from the live set here too, so a config change narrows the DM gate without
  // a restart. Best-effort and re-entry-guarded: "open" fires on every reconnect.
  let seeding = false;
  const seedFromGroups = async (sock: WASocket): Promise<void> => {
    if (seeding) {
      return;
    }
    seeding = true;
    try {
      const groups = await sock.groupFetchAllParticipating();
      let groupCount = 0;
      let pairCount = 0;
      for (const [jid, meta] of Object.entries(groups)) {
        if (!isAllowedGroup(jid)) {
          live.dropGroup(jid);
          continue;
        }
        groupCount += 1;
        pairCount += learnGroup(sock, jid, meta);
      }
      logger.info(
        { groups: groupCount, live: live.all().length, pairs: pairCount },
        "seeded lid map and live members from group metadata",
      );
      await flushLidMap();
      await flushLive();
    } catch (error) {
      logger.warn({ error }, "failed to seed lid map from group metadata");
    } finally {
      seeding = false;
    }
  };

  /** Learn lid pairs for one group (member joined, group joined); best-effort, never throws. */
  const seedGroup = async (sock: WASocket, jid: string): Promise<void> => {
    if (!isAllowedGroup(jid)) {
      return;
    }
    try {
      learnGroup(sock, jid, await sock.groupMetadata(jid));
    } catch (error) {
      logger.warn({ error, jid }, "failed to seed lid map for group");
    }
  };

  // ---- history and reactions ---------------------------------------------

  /** Track the oldest known message per group, to anchor on-demand backfill. */
  const updateAnchor = (jid: string, msg: WAMessage): void => {
    const ts = messageTs(msg);
    const cur = anchors[jid];
    if (!cur || ts < cur.ts) {
      anchors[jid] = { fromMe: Boolean(msg.key?.fromMe), id: msg.key?.id, ts };
      anchorsDirty = true;
    }
  };

  /** Dedup a history message id against the seen-set; returns false if already seen. */
  const dedupeHistoryMsgId = (msgId: string | null | undefined): boolean => {
    // no id: can't dedup, allow through
    if (!msgId) {
      return true;
    }
    if (historySeen.has(msgId)) {
      return false;
    }
    historySeen.add(msgId);
    return true;
  };

  /** Record the text/media body of a history message plus any URL resources. */
  const recordHistoryBody = async (
    jid: string,
    msg: WAMessage,
    msgId: string,
    isDM: boolean,
  ): Promise<void> => {
    // Same mention-token resolution as the live path: backfilled rows feed the
    // same tail/search corpus, so they should carry names, not raw digits.
    const text = resolveMentions(
      extractText(msg.message),
      getContextInfo(msg.message)?.mentionedJid,
      mentionLookupFor(currentSock ? getBot(currentSock) : null),
    );
    const placeholder = mediaPlaceholder(msg.message);
    if (!text && !placeholder) {
      return;
    }
    const ts = messageTs(msg);
    const sender = userPart(msg.key.participant ?? jid);
    const name = msg.pushName ?? undefined;
    // Learn the lid->phone pairing from history too (the key carries the phone on
    // its alt fields), so mentions resolve even before the person speaks live.
    rememberLid(sender, userPart(phoneNumberJid(msg.key) ?? "") || undefined, name);
    const surface = isDM ? "dm" : "group";
    await store.recordMessage(jid, {
      id: msgId,
      // No pushName on the synced record: resolve a name so the row doesn't
      // render as raw lid digits downstream.
      n: name ?? mentionLookupFor(null)(sender),
      role: msg.key.fromMe ? "assistant" : "user",
      s: sender,
      surface,
      t: ts,
      x: text || (placeholder as string),
    });
    for (const url of extractUrls(text)) {
      await store.recordResource(jid, { n: name, s: sender, t: ts, url });
    }
    updateAnchor(jid, msg);
  };

  /** Record reactions embedded on a history-synced message. */
  const recordHistoryReactions = async (
    jid: string,
    reactions: proto.IReaction[],
    msgId: string,
    fallbackTs: number,
  ): Promise<void> => {
    for (const r of reactions) {
      const reactor = userPart(r?.key?.participant ?? r?.key?.remoteJid ?? "");
      if (!reactor || !msgId) {
        continue;
      }
      const rt = Number(r?.senderTimestampMs);
      await store.recordReaction(jid, {
        emoji: r?.text || "",
        n: lidMap.get(reactor)?.name ?? null,
        s: reactor,
        t: Number.isFinite(rt) && rt > 0 ? Math.floor(rt / 1000) : fallbackTs,
        target: msgId,
      });
    }
  };

  /**
   * Record one history-synced message (and any reactions embedded on it) into the
   * buffer. Record-only: history never triggers a reply. Deduped within the
   * process via `historySeen`; downstream consumers also dedup by
   * content/reactor, so cross-restart re-syncs stay clean.
   */
  const recordHistoryMessage = async (msg: WAMessage): Promise<void> => {
    const jid = msg?.key?.remoteJid ?? "";
    const isGroup = jid.endsWith("@g.us");
    const isDM =
      !isGroup && jid !== "" && !jid.endsWith("@broadcast") && !jid.endsWith("@newsletter");
    if (!isGroup && !isDM) {
      return;
    }
    if (isGroup && !isAllowedGroup(jid)) {
      return;
    }
    const msgId = msg.key?.id;
    if (!dedupeHistoryMsgId(msgId)) {
      return;
    }
    await recordHistoryBody(jid, msg, msgId as string, isDM);
    if (Array.isArray(msg.reactions) && msg.reactions.length > 0) {
      await recordHistoryReactions(jid, msg.reactions, msgId as string, messageTs(msg));
    }
  };

  /** Process one live reaction item from the messages.reaction event. */
  const processReactionItem = async (
    item: BaileysEventMap["messages.reaction"][number],
  ): Promise<void> => {
    const key = item?.key ?? {};
    const reaction = item?.reaction ?? {};
    const reactorKey = reaction.key ?? {};
    const target = key.id;
    const jid = key.remoteJid ?? reactorKey.remoteJid ?? "";
    if (!target || !jid) {
      return;
    }
    // ignore the bot's own reactions
    if (reactorKey.fromMe) {
      return;
    }
    if (jid.endsWith("@g.us") && !isAllowedGroup(jid)) {
      return;
    }
    const reactor = userPart(reactorKey.participant ?? reactorKey.remoteJid ?? "");
    await store.recordReaction(jid, {
      emoji: reaction.text || "",
      n: lidMap.get(reactor)?.name ?? null,
      s: reactor,
      t: resolveReactionTs(reaction.senderTimestampMs),
      target,
    });
  };

  // ---- attachments -------------------------------------------------------

  /**
   * Download the image on a message and return it as a data URL the Bot can
   * hand to the model, or null if there's no image, it's over the size cap, or
   * the download fails. We don't resize: WhatsApp already compresses images and
   * the model provider downsizes anything large server-side.
   */
  const downloadImage = async (sock: WASocket, msg: WAMessage): Promise<Media | null> => {
    const image = msg.message?.imageMessage;
    if (!image) {
      return null;
    }
    try {
      const buf = await downloadBuffer(sock, msg);
      if (!buf?.length || buf.length > env.maxImageBytes) {
        logger.warn(
          { bytes: buf?.length ?? 0, cap: env.maxImageBytes },
          "image skipped (empty or over size cap)",
        );
        return null;
      }
      const mime = image.mimetype || "image/jpeg";
      return { dataUrl: `data:${mime};base64,${buf.toString("base64")}`, mime };
    } catch (error) {
      logger.warn({ error }, "failed to download image");
      return null;
    }
  };

  /**
   * Download the document on a message and turn it into something the Bot can
   * use: PDFs become a file-part `Media`; text/code and office/OpenDocument files
   * are flattened to a labelled text block. Returns null when there's no document,
   * it's over the size cap, the download fails, or it's an unreadable binary (in
   * which case the transcript keeps the [document] placeholder).
   */
  const downloadDocument = async (sock: WASocket, msg: WAMessage): Promise<DocResult | null> => {
    const doc = documentContent(msg.message);
    if (!doc) {
      return null;
    }
    const fileName = doc.fileName ?? null;
    const mime = doc.mimetype ?? null;
    try {
      const buf = await downloadBuffer(sock, msg);
      if (!buf?.length || buf.length > env.maxDocBytes) {
        logger.warn(
          { bytes: buf?.length ?? 0, cap: env.maxDocBytes, fileName },
          "document skipped (empty or over size cap)",
        );
        return null;
      }
      const kind = categorizeDocument(mime, fileName);
      if (kind === "pdf") {
        // The count is best-effort (null when we can't tell, e.g. object-stream
        // PDFs), so we only skip on a count we're confident exceeds the cap,
        // erring toward forwarding rather than dropping a readable doc.
        const pages = pdfPageCount(buf);
        if (pages !== null && pages > env.maxPdfPages) {
          logger.info(
            { cap: env.maxPdfPages, fileName, pages },
            "pdf skipped (over page cap), keeping placeholder",
          );
          return null;
        }
        const pdfMime = mime || "application/pdf";
        return {
          kind: "media",
          media: { dataUrl: `data:${pdfMime};base64,${buf.toString("base64")}`, mime: pdfMime },
        };
      }
      const text = extractDocumentText(buf, mime, fileName);
      if (text) {
        return { kind: "text", text: formatDocumentContext(fileName, mime, text) };
      }
      logger.info({ fileName, mime }, "document not readable, keeping placeholder");
      return null;
    } catch (error) {
      logger.warn({ error, fileName }, "failed to download document");
      return null;
    }
  };

  /**
   * Download the voice note / audio on a message and transcribe it to text via
   * the AI Gateway, mirroring how downloadDocument flattens a doc to text.
   * Returns the transcript, or null when there's no audio, transcription isn't
   * configured, it's over the size/duration cap, or the download/STT fails (in
   * which case the transcript keeps the [audio] placeholder).
   */
  const downloadAudio = async (sock: WASocket, msg: WAMessage): Promise<string | null> => {
    if (!deps.transcribeModel) {
      return null;
    }
    const audio = audioContent(msg.message);
    if (!audio) {
      return null;
    }
    const seconds = Number(audio.seconds ?? 0);
    if (seconds > env.maxAudioSeconds) {
      logger.info(
        { cap: env.maxAudioSeconds, seconds },
        "voice note skipped (over duration cap), keeping placeholder",
      );
      return null;
    }
    try {
      const buf = await downloadBuffer(sock, msg);
      if (!buf?.length || buf.length > env.maxAudioBytes) {
        logger.warn(
          { bytes: buf?.length ?? 0, cap: env.maxAudioBytes },
          "voice note skipped (empty or over size cap)",
        );
        return null;
      }
      const transcript = await transcribeAudio(buf, deps.transcribeModel, {
        logger,
        signal: AbortSignal.timeout(env.transcribeTimeoutMs),
      });
      if (!transcript) {
        logger.info("voice note transcription empty, keeping placeholder");
      }
      return transcript;
    } catch (error) {
      logger.warn({ error }, "failed to download/transcribe voice note");
      return null;
    }
  };

  /**
   * Fetch any attachment on a message we're about to reply to: images and PDFs
   * become model file-part `media`; readable text/office docs become an untrusted
   * context block; a voice note is transcribed to text the Bot answers as the
   * message. Done only once we know we're replying, so attachments shared in the
   * group don't each cost a fetch.
   */
  const collectAttachments = async (
    sock: WASocket,
    msg: WAMessage,
    hasImage: boolean,
    hasDocument: boolean,
    hasAudio: boolean,
  ): Promise<{
    media?: Media[];
    docContext?: string[];
    transcript?: string;
    quotedImageOnly?: boolean;
  }> => {
    let media: Media[] | undefined;
    let docContext: string[] | undefined;
    let transcript: string | undefined;
    let quotedImageOnly: boolean | undefined;
    const vision = cfg().vision_enabled;
    if (vision && hasImage) {
      const img = await downloadImage(sock, msg);
      if (img) {
        media = [img];
      }
    }
    // A reply quoting an image: fetch the quoted image too (after any directly
    // attached one), so "reply to a photo and @mention the bot" lets the model
    // see what's being talked about. Same size cap and failure handling as a
    // direct image; the reconstructed message walks the ordinary download path.
    if (vision) {
      const quotedSrc = quotedImageSource(msg);
      const quotedImg = quotedSrc && (await downloadImage(sock, quotedSrc));
      if (quotedImg) {
        quotedImageOnly = !media;
        media = [...(media ?? []), quotedImg];
      }
    }
    if (env.docsEnabled && hasDocument) {
      const doc = await downloadDocument(sock, msg);
      if (doc?.kind === "media") {
        media = [...(media ?? []), doc.media];
      } else if (doc?.kind === "text") {
        docContext = [doc.text];
      }
    }
    if (env.audioEnabled && hasAudio) {
      transcript = (await downloadAudio(sock, msg)) ?? undefined;
    }
    return { docContext, media, quotedImageOnly, transcript };
  };

  // ---- reply path --------------------------------------------------------

  /** Record an inbound live message body and any extracted URL resources. */
  const recordInboundMessage = async (
    jid: string,
    msgId: string | null | undefined,
    sender: string,
    senderName: string | undefined,
    ts: number,
    surface: "dm" | "group",
    text: string,
    placeholder: string | null,
  ): Promise<void> => {
    rememberName(sender, senderName);
    // A row without a name renders as raw lid digits everywhere downstream (the
    // conversation tail, /messages, the digest): resolve one from the roster /
    // lid map rather than storing nothing.
    const n = senderName ?? mentionLookupFor(null)(sender);
    await store.recordMessage(jid, {
      id: msgId ?? undefined,
      n,
      role: "user",
      s: sender,
      surface,
      t: ts,
      x: text || (placeholder as string),
    });
    for (const url of extractUrls(text)) {
      await store.recordResource(jid, { n, s: sender, t: ts, url });
    }
  };

  /**
   * Determine whether a live group/DM message should trigger a reply and return
   * the cleaned prompt text (or null to skip). Also logs the per-message debug
   * line and applies the DM policy.
   */
  const resolveAgentTrigger = (args: {
    msg: WAMessage;
    isDM: boolean;
    isSelfChat: boolean;
    bot: Bot;
    text: string;
    hasAttachment: boolean;
    jid: string;
    sender: string;
    senderPhone: string | null;
  }): { triggeredText: string | null } | null => {
    const { msg, isDM, isSelfChat, bot, text, hasAttachment, jid, sender, senderPhone } = args;
    const ctx = getContextInfo(msg.message);
    // A structured @-mention (groups) OR, in a DM where WhatsApp has no mention
    // picker, the bot's name typed as text ("@vibey"). Either counts as tagging
    // the bot; in a DM it changes nothing about who answers, it just means the
    // token should be stripped out of the prompt.
    const botMentioned = mentionsBot(ctx, bot) || (isDM && mentionsBotByName(text, bot.name));
    if (
      !shouldReply({
        isDM,
        isSelfChat,
        policy: { dm_policy: cfg().dm_policy, dmAllowlist },
        sender,
        senderPhone,
        whitelist,
      })
    ) {
      logger.info({ jid, policy: cfg().dm_policy, sender, senderPhone }, "ignoring DM by policy");
      return null;
    }
    // In a DM the whole text is the prompt; strip the @-mention token when the
    // sender typed the bot's name, so the Bot sees clean text (mirrors how the
    // group mention path strips it).
    const dmText = botMentioned ? stripBotMention(text, bot).trim() || text : text;
    const triggeredText = isDM
      ? dmText
      : triggerText(text, bot, ctx, { mode: cfg().trigger_mode, prefix: cfg().trigger_prefix });
    const isTriggered = isDM ? Boolean(text || hasAttachment) : triggeredText !== null;
    logger.debug(
      {
        botLid: bot.lid,
        botNumber: bot.number,
        from: sender,
        jid,
        mentioned: (ctx?.mentionedJid ?? []).map(userPart),
        text: text.slice(0, 80),
        triggered: isTriggered,
      },
      "inbound message",
    );
    if (!isTriggered) {
      return null;
    }
    return { triggeredText };
  };

  /** Send a graceful failure note to the user and record it in the store. */
  const sendGracefulFailure = async (sock: WASocket, bot: Bot, jid: string): Promise<void> => {
    const note = "Something went wrong handling that one - give it a moment and try again.";
    try {
      await sendText(sock, jid, note);
    } catch (sendError) {
      logger.error({ err: sendError, jid }, "failed to send graceful failure note");
    }
    // Record the note too, guarded separately so a logging failure can't crash the loop.
    try {
      await store.recordMessage(jid, {
        n: botName(),
        role: "assistant",
        s: bot.number as string,
        surface: jid.endsWith("@g.us") ? "group" : "dm",
        t: Math.floor(Date.now() / 1000),
        x: note,
      });
    } catch (recordError) {
      logger.error({ err: recordError, jid }, "failed to record graceful failure note");
    }
  };

  /** Build context, call the hub, send the reply, and record it in the store. */
  const sendAgentReply = async (args: {
    sock: WASocket;
    bot: Bot;
    jid: string;
    prompt: string;
    /** Short id of the message being answered; null when there is nothing to quote. */
    messageId?: string | null;
    media: Media[] | undefined;
    sender: string;
    senderName: string | undefined;
    surface: "dm" | "group";
    senderPhone: string | null;
    extraContext?: string[];
  }): Promise<void> => {
    const { sock, bot, jid, prompt, media, sender, senderName, surface, senderPhone } = args;
    const buildContext = async (): Promise<string[]> => {
      const blocks: string[] = [];
      try {
        // 20 rows = 19 prior lines after the current-message drop; enough tail
        // to resolve "this"/"that" references in an active group without
        // meaningfully growing the prompt (each line clips at 300 chars).
        const recent = await store.recentMessages(jid, 20);
        const block = buildConversationContext(recent, {
          botName: botName(),
          lookup: mentionLookupFor(null),
          surface,
        });
        if (block) {
          blocks.push(block);
        }
      } catch (contextError) {
        logger.warn({ err: contextError, jid }, "failed to build conversation context");
      }
      if (surface === "group" && live.ready()) {
        const membersBlock = formatMemberContext(roster());
        if (membersBlock) {
          blocks.push(membersBlock);
        }
      }
      // Extracted document text and the quoted message (already labelled); the
      // channel fences each block as untrusted, so it reads as data, never
      // instructions.
      if (args.extraContext?.length) {
        blocks.push(...args.extraContext);
      }
      return blocks;
    };
    // Pre-ask work runs concurrently: the store read and the "composing"
    // indicator each cost their own round trip and neither depends on the other.
    const [context] = await Promise.all([buildContext(), setPresence(sock, jid, "composing")]);
    logger.info({ hasMedia: Boolean(media), jid, sender }, "forwarding to hub");
    let result: AgentReply;
    try {
      result = await askAgent({
        context: context.length ? context : undefined,
        media,
        message: prompt,
        // The handle the Bot needs to reply to or react to this exact message.
        messageId: args.messageId ?? undefined,
        sender,
        senderName,
        senderPhone,
        surface,
        token: jid,
      });
    } catch (error) {
      // The hub call failing (timeout, 5xx after the retry budget) is exactly
      // what the graceful note exists for: the user watched "typing" start, so
      // ending in silence reads as being ignored.
      logger.error({ error, jid, sender }, "hub request failed");
      await sendGracefulFailure(sock, bot, jid);
      return;
    }
    const { reply } = result;
    // Clearing the typing indicator is cosmetic and the send below ends it
    // anyway: don't let a WhatsApp round trip delay (or a failure kill) the
    // actual reply.
    void setPresence(sock, jid, "paused");
    if (reply) {
      const sent = await sendText(sock, jid, reply);
      // Record the bot's own reply so the transcript is two-sided.
      await store.recordMessage(jid, {
        id: sent?.key?.id ?? undefined,
        n: botName(),
        role: "assistant",
        s: bot.number as string,
        surface,
        t: Math.floor(Date.now() / 1000),
        x: reply,
      });
    }
  };

  /**
   * Reply to an edited message when the edit added an @-mention of the bot (group
   * only) and we haven't already replied to that message. An edit's new content
   * rides in a protocolMessage / update rather than a fresh message body, so it
   * slips past the normal trigger path; this is the catch for it.
   */
  const replyToEditIfMentioned = async (
    sock: WASocket,
    bot: Bot,
    jid: string,
    key: WAMessageKey,
    editedContent: proto.IMessage | null | undefined,
    targetId: string | null | undefined,
    senderName: string | undefined,
  ): Promise<void> => {
    const ctx = getContextInfo(editedContent);
    const triggeredText = shouldReplyToEdit({
      bot,
      ctx,
      fromMe: key?.fromMe,
      groups: groupGate,
      jid,
      mode: cfg().trigger_mode,
      prefix: cfg().trigger_prefix,
      repliedIds,
      targetId,
      text: resolveMentions(extractText(editedContent), ctx?.mentionedJid, mentionLookupFor(bot)),
    });
    if (triggeredText === null) {
      return;
    }
    markReplied(targetId);
    if (key?.id) {
      markProcessed(key.id);
    }
    const sender = userPart(key.participant ?? jid);
    // The phone-based identity from the key (modern WA uses an opaque @lid for
    // participant; the alt key fields carry the real phone) so the Bot's admin
    // check works for edits, same as live messages.
    const senderPhone = userPart(phoneNumberJid(key) ?? "") || null;
    logger.info({ jid, targetId }, "replying to an edited-in mention");
    await sendAgentReply({
      bot,
      jid,
      media: undefined,
      prompt: triggeredText,
      sender,
      senderName,
      senderPhone,
      sock,
      surface: "group",
    });
  };

  /**
   * Collect any attachments (image/PDF media, document text, a transcribed voice
   * note), build the prompt to forward (caption / cleaned mention / transcript /
   * no-caption anchor), and dispatch the reply.
   */
  const collectAndDispatch = async (args: {
    bot: Bot;
    hasAudio: boolean;
    hasDocument: boolean;
    hasImage: boolean;
    isDM: boolean;
    jid: string;
    /** Short id of this message, so the Bot can quote or react to it. */
    messageId: string | null;
    msg: WAMessage;
    msgId: string | null | undefined;
    sender: string;
    senderName: string | undefined;
    senderPhone: string | null;
    sock: WASocket;
    surface: "dm" | "group";
    text: string;
    triggeredText: string | null;
  }): Promise<void> => {
    const { media, docContext, transcript, quotedImageOnly } = await collectAttachments(
      args.sock,
      args.msg,
      args.hasImage,
      args.hasDocument,
      args.hasAudio,
    );
    // A voice note that couldn't be transcribed (STT off or failed) leaves an
    // empty prompt and the message is dropped silently: a member's
    // untranscribable voice note isn't ours to guess at.
    const prompt =
      (args.isDM ? args.text : args.triggeredText) ||
      transcript ||
      (quotedImageOnly
        ? "(replying to the attached image, no added text)"
        : noCaptionNote(media, docContext));
    if (!prompt && !media && !docContext) {
      return;
    }
    // A reply carries the message it quotes in contextInfo. Forward it as a
    // context block, with the quoted author and any mentions inside it
    // resolved to names, so "this" has a referent.
    const quoted = quotedText(args.msg);
    let quotedBlock: string | undefined;
    if (quoted) {
      const lookup = mentionLookupFor(args.bot);
      const body = resolveMentions(quoted.text, quoted.mentionedJid, lookup);
      const clipped = body.length > 300 ? `${body.slice(0, 300)}...` : body;
      const author = lookup(quoted.sender) || quoted.sender || "someone";
      quotedBlock = `This message is a reply to ${author}: "${clipped}"`;
    }
    const extraContext = [...(docContext ?? []), ...(quotedBlock ? [quotedBlock] : [])];
    await sendAgentReply({
      bot: args.bot,
      extraContext: extraContext.length > 0 ? extraContext : undefined,
      jid: args.jid,
      media,
      messageId: args.messageId,
      prompt,
      sender: args.sender,
      senderName: args.senderName,
      senderPhone: args.senderPhone,
      sock: args.sock,
      surface: args.surface,
    });
    markReplied(args.msgId);
  };

  /** Handle a single message from messages.upsert. */
  const handleUpsertMessage = async (msg: WAMessage, sock: WASocket, bot: Bot): Promise<void> => {
    // Our own identities, so classifyMessage can recognise the account's
    // self-chat (the one place a fromMe message is kept).
    const selfIds = new Set([bot.number, bot.lid].filter(Boolean) as string[]);
    const classification = classifyMessage(msg, groupGate, selfIds, (info) =>
      logger.info(info, "inbound non-group message"),
    );
    if (!classification) {
      return;
    }
    const { isDM, isSelfChat, jid } = classification;

    // Edits arrive as protocolMessages (no normal text body) and can reuse the
    // original message id, so catch them before the processed-id dedup below.
    const edit = extractEdit(msg.message);
    if (edit) {
      await replyToEditIfMentioned(
        sock,
        bot,
        jid,
        msg.key,
        edit.edited,
        edit.targetId,
        msg.pushName ?? undefined,
      );
      return;
    }

    const msgId = msg.key.id;
    // Loop guard for the self-chat: the bot's own reply is also a fromMe message
    // in the same chat, so it would re-enter here. Skip anything the bridge just
    // sent (recorded in sentStore on every send) before it can re-trigger.
    if (msg.key.fromMe && sentStore.get({ id: msgId, remoteJid: jid })) {
      return;
    }
    // Idempotency: skip ids we've already handled (redelivery / retry replay).
    if (msgId) {
      if (processedIds.has(msgId)) {
        logger.debug({ jid, msgId }, "skipping already-processed message");
        return;
      }
      markProcessed(msgId);
    }

    // Identity/time/surface are computed before the text check so media-only
    // messages can still be recorded into the transcript.
    const { sender, senderName, senderPhone, surface, ts } = resolveSenderInfo(msg, jid, isDM);
    rememberLid(sender, senderPhone, senderName);
    live.touchName(senderPhone, sender, senderName);
    updateAnchor(jid, msg);

    // messageText renders a shared contact card into readable text so it
    // reaches the Bot; a plain message is just its caption / body. Mention
    // tokens ("@61408461216") resolve to names here, before anything downstream
    // sees the text, so one pass covers the stored record, the trigger text and
    // the prompt alike.
    const text = resolveMentions(
      messageText(msg.message),
      getContextInfo(msg.message)?.mentionedJid,
      mentionLookupFor(bot),
    );
    const placeholder = mediaPlaceholder(msg.message);
    const hasImage = Boolean(msg.message?.imageMessage);
    const hasDocument = Boolean(documentContent(msg.message));
    const hasAudio = Boolean(audioContent(msg.message));
    // Nothing we can record or act on (e.g. a protocol/system message).
    if (!text && !placeholder) {
      return;
    }

    // Remember the key behind a short id before anything else can return: the
    // Bot can only quote or react to a message that went through here, and the
    // id it gets back is the only handle it is ever given on the real key.
    const messageId = messageIndex.remember(msg.key, text || placeholder);

    // Capture every message into the buffer (powers recap + resources) BEFORE
    // any reply gating, so the transcript stays complete even for DMs we
    // won't answer. Caption-less media records as its typed placeholder.
    await recordInboundMessage(jid, msgId, sender, senderName, ts, surface, text, placeholder);

    const trigger = resolveAgentTrigger({
      bot,
      hasAttachment: hasImage || hasDocument || hasAudio,
      isDM,
      isSelfChat,
      jid,
      msg,
      sender,
      senderPhone,
      text,
    });
    if (!trigger) {
      return;
    }
    await collectAndDispatch({
      bot,
      hasAudio,
      hasDocument,
      hasImage,
      isDM,
      jid,
      messageId,
      msg,
      msgId,
      sender,
      senderName,
      senderPhone,
      sock,
      surface,
      text,
      triggeredText: trigger.triggeredText,
    });
  };

  /** Handle messages.upsert events: route and reply to incoming messages. */
  const handleMessagesUpsert = async (
    sock: WASocket,
    { messages, type }: BaileysEventMap["messages.upsert"],
  ): Promise<void> => {
    if (type !== "notify" || stopped) {
      return;
    }
    const bot = getBot(sock);
    // Handle each message on its chat's serial queue: same-chat messages stay in
    // delivery order, different chats run concurrently. inFlight is bumped
    // synchronously so shutdown drains queued work too.
    const pending = messages.map((msg) => {
      const jid = msg.key.remoteJid ?? "";
      inFlight += 1;
      return chatQueue.run(jid, async () => {
        try {
          await handleUpsertMessage(msg, sock, bot);
        } catch (error) {
          // A failed hub call already answered the user with the graceful note
          // inside sendAgentReply; anything surfacing here failed outside the
          // reply path.
          const sender = userPart(msg.key.participant ?? "");
          logger.error({ error, jid, sender }, "failed to handle message");
        } finally {
          inFlight -= 1;
        }
      });
    });
    await Promise.all(pending);
  };

  /**
   * Handle one messages.update entry: an edit that may @-mention the bot. Queued
   * on the same per-chat queue as upserts so an edited-in mention can't interleave
   * with an in-flight reply for the same chat.
   */
  const queueEditReply = (sock: WASocket, u: WAMessageUpdate): void => {
    const newMsg = u?.update?.message;
    if (!newMsg) {
      return;
    }
    const jid = u.key?.remoteJid ?? "";
    inFlight += 1;
    void chatQueue.run(jid, async () => {
      try {
        const bot = getBot(sock);
        const edit = extractEdit(newMsg);
        const editedContent = edit ? edit.edited : newMsg;
        const targetId = edit ? edit.targetId : u.key?.id;
        await replyToEditIfMentioned(
          sock,
          bot,
          jid,
          u.key,
          editedContent,
          targetId,
          u.update?.pushName ?? undefined,
        );
      } catch (error) {
        logger.error({ error }, "failed to handle message update");
      } finally {
        inFlight -= 1;
      }
    });
  };

  /** Handle messaging-history.set events: backfill older messages into the store. */
  const handleHistorySet = async ({
    contacts,
    lidPnMappings,
    messages: history,
  }: BaileysEventMap["messaging-history.set"]): Promise<void> => {
    // The sync payload carries explicit lid<->phone pairs and contact cards
    // (which, unlike group metadata, include names): free lid-map fuel.
    for (const m of lidPnMappings ?? []) {
      rememberLid(userPart(m?.lid), userPart(m?.pn));
    }
    for (const pair of lidPairsFrom(contacts)) {
      rememberLid(pair.lid, pair.phone, pair.name);
    }
    if (!Array.isArray(history) || history.length === 0) {
      await flushLidMap();
      return;
    }
    logger.info({ count: history.length }, "history sync: backfilling messages");
    for (const msg of history) {
      try {
        await recordHistoryMessage(msg);
      } catch (error) {
        logger.warn({ error }, "failed to record history message");
      }
    }
    await flushAnchors();
    await flushLidMap();
  };

  // ---- proactive sends (the HTTP API) ------------------------------------

  /**
   * Ask the primary device for older history in a group, anchored on the oldest
   * message we've seen. Results arrive via the messaging-history.set handler.
   */
  const requestBackfill = async (
    group: string,
    count: number,
  ): Promise<{ anchor: string; requested: number }> => {
    const sock = requireSock();
    if (typeof sock.fetchMessageHistory !== "function") {
      throw new TypeError("fetchMessageHistory unavailable in this Baileys version");
    }
    const anchor = anchors[group];
    if (!anchor?.id) {
      throw new Error("no anchor message yet for this group; let it sync first");
    }
    const key = { fromMe: Boolean(anchor.fromMe), id: anchor.id, remoteJid: group };
    logger.info({ anchor: anchor.id, count, group }, "requesting history backfill");
    await sock.fetchMessageHistory(count, key, anchor.ts);
    return { anchor: anchor.id, requested: count };
  };

  /**
   * DM the maintainer a rendered message, deduped on `key`. Shared by /report
   * and /invite. The key is marked BEFORE awaiting the send so two concurrent
   * identical requests can't both pass the has() check and each DM the
   * maintainer; on delivery failure it is dropped again so a genuine retry can
   * still get through.
   */
  const forwardToMaintainer = async (
    keys: ReturnType<typeof boundedSet>,
    key: string,
    render: () => string,
    what: string,
  ): Promise<{ delivered: boolean; duplicate?: boolean }> => {
    const maintainer = cfg().maintainer_jid;
    if (!maintainer) {
      logger.warn(`${what} received but maintainer_jid is not configured`);
      return { delivered: false };
    }
    const sock = requireSock();
    if (keys.has(key)) {
      logger.info(`duplicate ${what}, not re-sending`);
      return { delivered: true, duplicate: true };
    }
    keys.add(key);
    try {
      await sendText(sock, maintainer, render());
    } catch (error) {
      keys.delete(key);
      throw error;
    }
    logger.info(`${what} forwarded to maintainer`);
    return { delivered: true };
  };

  const sendReport = (
    report: FeatureReport,
  ): Promise<{ delivered: boolean; duplicate?: boolean }> =>
    forwardToMaintainer(
      reportedKeys,
      reportDedupKey(report),
      () => buildReportMessage(report, botName()),
      "feature report",
    );

  const sendInvite = (
    invite: InviteRequest,
  ): Promise<{ delivered: boolean; duplicate?: boolean }> =>
    forwardToMaintainer(
      invitedKeys,
      inviteDedupKey(invite),
      () => buildInviteMessage(invite, botName()),
      "member invite",
    );

  /**
   * Deliver a proactive message (e.g. the daily digest) to a DM. The target is
   * allowlisted to the maintainer, the owners and the digest recipients so a
   * compromised secret can't spam arbitrary chats through the bridge. Group
   * JIDs never reach here: `handleSend` in server.ts refuses them in code.
   */
  const sendProactive = async (
    jid: string,
    text: string,
    idempotencyKey?: string,
  ): Promise<{ sent: boolean; deduped?: boolean }> => {
    if (idempotencyKey && sentKeys.has(idempotencyKey)) {
      logger.info({ idempotencyKey, jid }, "skipping duplicate proactive send");
      return { deduped: true, sent: true };
    }
    const maintainer = cfg().maintainer_jid;
    const allowed =
      Boolean(maintainer && jid === maintainer) ||
      isOwner(owners, jid, null) ||
      isOwner(digestRecipients, jid, null);
    if (!allowed) {
      logger.warn({ jid }, "refusing proactive send to non-allowlisted jid");
      return { sent: false };
    }
    const sock = requireSock();
    // Marked before the send, not after: a send that succeeds and then fails to
    // record would otherwise replay into a duplicate message, and a duplicate is
    // worse than a missing store entry.
    if (idempotencyKey) {
      sentKeys.add(idempotencyKey);
    }
    const sent = await sendText(sock, jid, text);
    // The reply landing is what ends "typing" on a proactive send: there is no
    // request-response turn behind it to clear the indicator.
    void setPresence(sock, jid, "paused");
    await store.recordMessage(jid, {
      id: sent?.key?.id ?? undefined,
      n: botName(),
      role: "assistant",
      s: userPart(sock.user?.id ?? ""),
      surface: "dm",
      t: Math.floor(Date.now() / 1000),
      x: text,
    });
    return { sent: true };
  };

  /** The identity gate every outbound verb shares, read fresh so config edits apply live. */
  const sendGate = (): SendTargetGate => ({
    groups: groupGate,
    isMember: (num) => whitelist.isMember(num),
    isOwnerJid: (j) => isOwner(owners, j, null),
    maintainerJid: cfg().maintainer_jid || undefined,
  });

  /**
   * Deliver a proactive image into a chat. Allowlisted to anywhere the bot
   * already replies (allowed groups, member / owner / maintainer DMs) and
   * rate-capped per chat per day.
   */
  const sendMediaProactive = async ({
    jid,
    mime,
    base64,
    caption,
  }: SendMediaPayload): Promise<{ sent: boolean; reason?: string }> => {
    const allowed = sendTargetAllowed(jid, sendGate());
    if (!allowed) {
      logger.warn({ jid }, "refusing media send to non-allowlisted jid");
      return { reason: "jid not allowlisted for sends", sent: false };
    }
    if (!mediaSendCounter.take(jid)) {
      logger.warn({ jid }, "media send refused (daily cap reached)");
      return { reason: "daily image limit reached for this chat", sent: false };
    }
    const buf = Buffer.from(base64, "base64");
    if (!buf.length || buf.length > env.maxSendMediaBytes) {
      return { reason: "image empty or over size cap", sent: false };
    }
    const sock = requireSock();
    const sent = await sock.sendMessage(jid, { caption, image: buf, mimetype: mime });
    sentStore.record(sent);
    await store.recordMessage(jid, {
      id: sent?.key?.id ?? undefined,
      n: botName(),
      role: "assistant",
      s: userPart(sock.user?.id ?? ""),
      surface: jid.endsWith("@g.us") ? "group" : "dm",
      t: Math.floor(Date.now() / 1000),
      x: caption?.trim() || "[image]",
    });
    return { sent: true };
  };

  /**
   * Decode every media item up front, enforcing the same byte cap as
   * /send-media. All of them before any of them is sent: half an envelope
   * delivered and then refused on the third file is not something the caller
   * can retry cleanly.
   */
  const mediaBuffers = (items: EnvelopeMedia[]): Buffer[] | null => {
    const buffers: Buffer[] = [];
    for (const item of items) {
      const buf = Buffer.from(item.base64, "base64");
      if (!buf.length || buf.length > env.maxSendMediaBytes) {
        return null;
      }
      buffers.push(buf);
    }
    return buffers;
  };

  /** Record one outbound message the envelope sent, so the transcript stays two-sided. */
  const recordOutbound = async (
    sock: WASocket,
    jid: string,
    sent: WAMessage | undefined,
    text: string,
  ): Promise<void> => {
    await store.recordMessage(jid, {
      id: sent?.key?.id ?? undefined,
      n: botName(),
      role: "assistant",
      s: userPart(sock.user?.id ?? ""),
      surface: jid.endsWith("@g.us") ? "group" : "dm",
      t: Math.floor(Date.now() / 1000),
      x: text,
    });
  };

  /**
   * The one outbound envelope: an optional quoted reply, a reaction, and up to
   * four images or documents, in that order, into one chat.
   *
   * Everything that decides whether this may happen is in `authoriseEnvelope`
   * (`send-envelope.ts`), including the rule that bare text into a group is
   * refused unless it quotes a message there. This function only resolves the
   * short ids to real keys and makes the Baileys calls. Every refusal happens
   * before the first send, because WhatsApp has no multi-message transaction:
   * once a part is in the chat there is no taking it back. A send that then
   * fails mid-flight still reports the ids that did land.
   */
  const sendEnvelope = async (
    envelope: SendEnvelope,
  ): Promise<{ sent: boolean; reason?: string; messageIds?: string[] }> => {
    const { jid } = envelope;
    // Before anything is spent: a send into a chat whose socket is down costs
    // the chat a daily slot for a message that never left.
    const sock = requireSock();
    const buffers = mediaBuffers(envelope.media ?? []);
    if (!buffers) {
      return { reason: "media empty or over size cap", sent: false };
    }
    const replyTo = envelope.reply_to ? messageIndex.lookup(envelope.reply_to) : undefined;
    const reactTo = envelope.react ? messageIndex.lookup(envelope.react.to) : undefined;
    const decision = authoriseEnvelope(
      envelope,
      { reactToJid: reactTo?.key.remoteJid, replyToJid: replyTo?.key.remoteJid },
      sendGate(),
      { media: mediaSendCounter, writes: envelopeWriteCounter },
    );
    if (!decision.ok) {
      logger.warn({ jid, reason: decision.reason }, "refusing send envelope");
      return { reason: decision.reason, sent: false };
    }
    const messageIds: string[] = [];

    // The quoted stub is the key plus a short text body: Baileys reads only
    // `key` and `message` off it, and the preview text is what renders in the
    // grey line above the reply.
    const quoted = replyTo
      ? ({ key: replyTo.key, message: { conversation: replyTo.preview } } as WAMessage)
      : undefined;

    if (envelope.react && reactTo) {
      const sent = await sock.sendMessage(jid, {
        react: { key: reactTo.key, text: envelope.react.emoji },
      });
      // A reaction is not a message in the transcript: WhatsApp keeps it on the
      // message it decorates, and the bridge records reactions on their own
      // event. Nothing to record or to hand back an id for.
      sentStore.record(sent);
    }

    if (envelope.text) {
      const sent = await sendText(sock, jid, envelope.text, quoted);
      // sendText already remembered it; remember is keyed on the message, so
      // asking again is how we get the id back rather than a second entry.
      const id = messageIndex.remember(sent?.key, envelope.text);
      if (id) {
        messageIds.push(id);
      }
      await recordOutbound(sock, jid, sent, envelope.text);
    }

    for (const [index, item] of (envelope.media ?? []).entries()) {
      const buf = buffers[index] as Buffer;
      // A quoted reply threads the first outbound message only: when the
      // envelope carries text that message already took the quote, and quoting
      // on every file would stack the same grey header three times.
      const quoteThis = envelope.text || index > 0 ? undefined : quoted;
      const content =
        item.kind === "image"
          ? { caption: item.caption, image: buf, mimetype: item.mime }
          : {
              caption: item.caption,
              document: buf,
              fileName: item.filename,
              mimetype: item.mime,
            };
      const sent = await sock.sendMessage(
        jid,
        content,
        quoteThis ? { quoted: quoteThis } : undefined,
      );
      sentStore.record(sent);
      const id = messageIndex.remember(sent?.key, item.caption ?? "");
      if (id) {
        messageIds.push(id);
      }
      await recordOutbound(
        sock,
        jid,
        sent,
        item.caption?.trim() ||
          (item.kind === "image" ? "[image]" : `[document] ${item.filename ?? ""}`.trim()),
      );
    }
    return { messageIds, sent: true };
  };

  // ---- connection lifecycle ----------------------------------------------

  const authPath = authDir(env.stateDir, acct);

  /** Drop the current socket without logging out (a redeploy must not re-pair). */
  const endSocket = (): void => {
    const sock = currentSock;
    currentSock = null;
    try {
      sock?.end?.(new Error("bridge closed the socket"));
    } catch {
      // best-effort
    }
  };

  /** Wait out the backoff, then reconnect unless stopped meanwhile. */
  const reconnectAfter = async (delayMs: number): Promise<void> => {
    await sleep(delayMs);
    if (stopped || currentSock) {
      return;
    }
    try {
      await startSocket();
    } catch (error) {
      logger.error({ error }, "reconnect failed");
    }
  };

  /** Schedule a reconnect with exponential backoff and full jitter, capped. */
  const scheduleReconnect = (code: number | undefined): void => {
    // The jitter matters as much as the delay: a fixed schedule from a
    // restarting container retries on the same beat every time, which is
    // exactly the pattern that reads as abuse. Never resets on failure, only
    // on a connection that opens.
    const delayMs = Math.round(
      Math.random() * Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS),
    );
    reconnectAttempts += 1;
    logger.warn({ attempt: reconnectAttempts, code, delayMs }, "connection closed, reconnecting");
    void reconnectAfter(delayMs);
  };

  /** Ask WhatsApp for a pairing code on the socket that just came up. */
  const requestPairingCode = async (sock: WASocket, phone: string): Promise<void> => {
    try {
      const code = await sock.requestPairingCode(phone);
      pairingCode = { at: Date.now(), code };
      latestQr = null;
      logger.info({ phone }, "pairing code issued; enter it under Linked devices");
    } catch (error) {
      logger.error({ error }, "failed to request pairing code");
    }
  };

  const handleConnectionUpdate = (sock: WASocket, update: Partial<ConnectionState>): void => {
    if (sock !== currentSock) {
      // A socket we already replaced (link restart) still emits its close.
      return;
    }
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      linking = true;
      if (pairingPhone) {
        // The socket is up once WhatsApp offers a QR; that is the moment a
        // pairing code can be requested. Once per socket.
        if (!pairingCode) {
          void requestPairingCode(sock, pairingPhone);
        }
      } else {
        latestQr = { at: Date.now(), qr };
        logger.info("QR issued; scan it from the link page");
      }
    }
    if (connection === "connecting") {
      conn = "connecting";
    }
    if (connection === "open") {
      conn = "open";
      registered = true;
      closeAttempts = 0;
      failingSince = null;
      lastCloseCode = null;
      reconnectAttempts = 0;
      linkAttempts = 0;
      linking = false;
      // A linked socket must never keep serving a scannable QR or a code.
      latestQr = null;
      pairingCode = null;
      pairingPhone = null;
      displayName = sock.user?.name ?? undefined;
      const phone = phoneDigits(userPart(sock.user?.id ?? ""));
      logger.info({ phone }, "connected to WhatsApp");
      if (phone && phone !== record.phone) {
        void deps.onPhone(phone).catch((error) => {
          logger.warn({ error }, "failed to persist the linked phone");
        });
      }
      // Fire-and-forget (this handler is sync): learn every group member's
      // lid->phone pairing up front so mentions of quiet members resolve
      // immediately, not only after they next speak.
      void seedFromGroups(sock);
    }
    if (connection === "close") {
      conn = "close";
      const code = (lastDisconnect?.error as DisconnectError | undefined)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      registered = Boolean(sock.authState.creds.registered) && !loggedOut;
      // Track a run of identical failures. A changing code is a flaky network; a
      // code that never moves is a condition retrying will never resolve.
      if (code !== lastCloseCode) {
        closeAttempts = 0;
        failingSince = new Date().toISOString();
      }
      lastCloseCode = code ?? null;
      closeAttempts += 1;
      if (closeAttempts === STUCK_AFTER_ATTEMPTS) {
        logger.error(
          { attempts: closeAttempts, code, failingSince },
          `WhatsApp connection stuck: ${closeAttempts} consecutive closes with code ${code}. Messages are being dropped. A persistent 405 usually means the WA Web version was refused; check the "using WhatsApp Web version" line.`,
        );
      }
      currentSock = null;
      if (stopped) {
        return;
      }
      if (loggedOut) {
        // The device was unlinked from the phone. The creds can never
        // reconnect, so clear them and wait for the page to link again.
        linking = false;
        latestQr = null;
        pairingCode = null;
        logger.warn({ code }, "logged out by WhatsApp; relink from the page");
        void rm(authPath, { force: true, recursive: true }).catch((error) => {
          logger.warn({ error }, "failed to clear auth state after logout");
        });
        return;
      }
      if (!registered) {
        linkAttempts += 1;
        if (linkAttempts >= LINK_MAX_ATTEMPTS) {
          linking = false;
          latestQr = null;
          pairingCode = null;
          logger.warn({ attempts: linkAttempts }, "linking timed out; POST /link to try again");
          return;
        }
      }
      scheduleReconnect(code);
    }
  };

  const startSocket = async (): Promise<void> => {
    await mkdir(authPath, { mode: 0o700, recursive: true });
    // oxlint-disable-next-line react-hooks/rules-of-hooks -- Baileys' name for its auth-state loader, not a React hook
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    registered = Boolean(state.creds.registered);
    const { version, source: versionSource } = await resolveWaVersion({
      fetchBaileys: fetchLatestBaileysVersion,
      fetchWaWeb: fetchLatestWaWebVersion,
      logger,
    });
    // Logged on every attempt: a version WhatsApp has rolled past is refused at
    // handshake with a 405 that looks nothing like a version problem, so this
    // line is the difference between a one-grep diagnosis and a long hunt.
    logger.info(
      { source: versionSource, version: version.join(".") },
      "using WhatsApp Web version",
    );

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        // Cache signal-key reads: the Baileys-recommended production setup, and
        // it reduces the file-store races that can corrupt Signal sessions.
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      // Answer a recipient's decryption-retry receipts by re-supplying the
      // message we sent, so it resolves instead of hanging on "Waiting for this
      // message".
      getMessage: (key) => {
        const msg = sentStore.get(key);
        logger.info(
          { hit: Boolean(msg), id: key.id, jid: key.remoteJid },
          "retry receipt: getMessage",
        );
        return Promise.resolve(msg);
      },
      logger,
      markOnlineOnConnect: false,
      msgRetryCounterCache,
      printQRInTerminal: false,
      // Pull WhatsApp's fuller history on link so backfill has something to ingest.
      shouldSyncHistoryMessage: () => true,
      syncFullHistory: env.syncFullHistory,
      version,
    });
    currentSock = sock;
    conn = "connecting";
    pairingCode = null;

    // All handlers registered through one typed binder: each arg is typed
    // against Baileys' BaileysEventMap.
    bindEvents(sock, {
      "connection.update": (update) => handleConnectionUpdate(sock, update),
      "creds.update": saveCreds,
      // A member change ships the affected participants (lid + phone); learn them
      // so "welcome @NewPerson" resolves before they've ever spoken. An "add"
      // also re-seeds the whole group in case the event carried only one id form.
      "group-participants.update": ({ id, action, participants }) => {
        if (!isAllowedGroup(id)) {
          return;
        }
        for (const pair of lidPairsFrom(participants)) {
          rememberLid(pair.lid, pair.phone, pair.name);
        }
        const parsed = participantsFrom(participants);
        if (action === "add") {
          for (const person of parsed) {
            live.upsert(id, person);
          }
          void seedGroup(sock, id);
        } else if (action === "remove") {
          for (const person of parsed) {
            live.remove(id, person);
          }
        }
      },
      // A group the number joined after connect (the invite-link route, or a
      // human adding it from their phone). Without this the live set and lid
      // map only learn it on the next reconnect, so a fresh group's DM gate
      // and mentions were wrong until a restart.
      "groups.upsert": (groups) => {
        for (const meta of groups ?? []) {
          if (!meta?.id || !isAllowedGroup(meta.id)) {
            continue;
          }
          learnGroup(sock, meta.id, meta);
          logger.info({ jid: meta.id, subject: meta.subject }, "group joined; seeded members");
        }
        void flushLidMap();
        void flushLive();
      },
      // Baileys learns lid<->phone pairings as it decrypts; mirror them into the
      // mention map so resolution keeps up without waiting for our own learning.
      "lid-mapping.update": (mapping) => {
        rememberLid(userPart(mapping?.lid), userPart(mapping?.pn));
      },
      // Emoji reactions arrive on their own event. Capture them so the Bot can
      // answer "most reacted" asks. Reactions never trigger a reply.
      "messages.reaction": async (items) => {
        for (const item of items ?? []) {
          try {
            await processReactionItem(item);
          } catch (error) {
            logger.error({ error }, "failed to record reaction");
          }
        }
      },
      // Edits delivered via messages.update (some clients/versions deliver the
      // edit here rather than as an upsert).
      "messages.update": (updates) => {
        if (stopped) {
          return;
        }
        for (const u of updates ?? []) {
          queueEditReply(sock, u);
        }
      },
      "messages.upsert": (payload) => handleMessagesUpsert(sock, payload),
      // History sync delivers older messages. Record-only: history never triggers a reply.
      "messaging-history.set": handleHistorySet,
    });
  };

  const drain = async (): Promise<void> => {
    const deadline = Date.now() + env.shutdownDrainMs;
    // oxlint-disable-next-line no-unmodified-loop-condition -- inFlight is decremented by concurrent message handlers
    while (inFlight > 0 && Date.now() < deadline) {
      await sleep(200);
    }
  };

  const flushAll = async (): Promise<void> => {
    await flushProcessed();
    await flushAnchors();
    await flushLidMap();
    await flushLive();
  };

  const loadPersisted = async (): Promise<void> => {
    // Seed cross-restart state so we don't re-reply to redelivered messages and
    // can anchor on-demand backfill from where we left off.
    try {
      for (const id of await store.loadProcessedIds()) {
        processedIds.add(id);
      }
      Object.assign(anchors, await store.loadAnchors());
      const savedLids = await store.loadLidMap();
      for (const [lid, entry] of Object.entries(savedLids)) {
        if (entry && typeof entry === "object") {
          lidMap.set(lid, { name: entry.name, phone: entry.phone });
        }
      }
      live.load(parseParticipants(await store.loadParticipants()));
    } catch (error) {
      logger.warn({ error }, "failed to load persisted state");
    }
  };

  const reloadOverlay = async (): Promise<void> => {
    overlay = await loadMembersOverlay(cfg().members_overlay_file, (error) =>
      logger.warn({ error, file: cfg().members_overlay_file }, "members overlay unreadable"),
    );
  };

  const health = (): AccountHealth => ({
    acct,
    attempts: closeAttempts,
    failingSince,
    lastCloseCode,
    whatsapp: currentSock ? conn : registered ? "close" : "unlinked",
  });

  const linkState = (): LinkState => {
    let status: LinkState["status"];
    if (currentSock && conn === "open") {
      status = "open";
    } else if (registered) {
      status = "closed";
    } else if (currentSock && linking) {
      status = "linking";
    } else {
      status = "unlinked";
    }
    const serving = status === "linking";
    const issued = pairingCode?.at ?? latestQr?.at ?? null;
    return {
      acct,
      age_ms: serving && issued !== null ? Date.now() - issued : null,
      pairing_code: serving ? (pairingCode?.code ?? null) : null,
      phone: pairingPhone ?? record.phone,
      qr: serving ? (latestQr?.qr ?? null) : null,
      status,
    };
  };

  const summary = (): AccountSummary => ({
    acct,
    bot: record.bot,
    channel_id: record.channel_id,
    phone: record.phone,
    status: linkState().status,
    ...(displayName ? { display_name: displayName } : {}),
  });

  return {
    acct,
    async applyRecord(next) {
      const before = record;
      record = next;
      groupGate = gateFrom(cfg());
      owners = parseOwnerIds(cfg().owner_jids.join(","));
      digestRecipients = parseOwnerIds(cfg().digest_recipient_jids.join(","));
      dmAllowlist = parseOwnerIds(cfg().dm_allowlist.join(","));
      if (before.config.members_overlay_file !== cfg().members_overlay_file) {
        await reloadOverlay();
      }
      const groupsChanged =
        before.config.group_policy !== cfg().group_policy ||
        before.config.allowed_groups.join("\n") !== cfg().allowed_groups.join("\n");
      if (groupsChanged && currentSock && conn === "open") {
        // Re-seed so the live set (and with it the `members` DM gate) tracks
        // the new allowlist now, not on the next reconnect.
        void seedFromGroups(currentSock);
      }
    },
    async destroy() {
      stopped = true;
      await drain();
      const sock = currentSock;
      currentSock = null;
      try {
        // logout() unlinks the device on the phone as well; end() alone would
        // leave a ghost "linked device" the owner has to remove by hand.
        await sock?.logout();
      } catch (error) {
        logger.warn({ error }, "logout failed; clearing local creds anyway");
      }
      try {
        sock?.end?.(new Error("account deleted"));
      } catch {
        // best-effort
      }
      clearInterval(flushTimer);
      await flushAll();
      await rm(path.dirname(authPath), { force: true, recursive: true });
      registered = false;
      linking = false;
      latestQr = null;
      pairingCode = null;
      logger.info("account destroyed: device logged out, creds deleted, store kept");
    },
    handle: {
      acct,
      getMembers: () => ({ members: roster(), ready: live.ready() }),
      onBackfill: requestBackfill,
      onInvite: sendInvite,
      onReport: sendReport,
      onSend: sendProactive,
      onSendEnvelope: sendEnvelope,
      onSendMedia: sendMediaProactive,
      store,
    },
    health,
    async joinGroup(invite) {
      const code = inviteCodeFrom(invite);
      if (!code) {
        throw new Error("invite must be a chat.whatsapp.com link or an invite code");
      }
      const sock = requireSock();
      const jid = await sock.groupAcceptInvite(code);
      if (!jid) {
        throw new Error("WhatsApp did not return a group for that invite");
      }
      // groups.upsert usually follows; seed now too so the very first message
      // in the new group already has the lid map and live set.
      void seedGroup(sock, jid);
      return jid;
    },
    async link(phone) {
      if (currentSock && conn === "open") {
        return linkState();
      }
      pairingPhone = phone;
      pairingCode = null;
      latestQr = null;
      linkAttempts = 0;
      reconnectAttempts = 0;
      linking = true;
      stopped = false;
      // A socket mid-backoff or mid-QR is replaced so the page gets a fresh
      // challenge now rather than whenever the old one rotates.
      endSocket();
      await startSocket();
      return linkState();
    },
    linkState,
    async listGroups() {
      const sock = requireSock();
      const groups = await sock.groupFetchAllParticipating();
      return Object.entries(groups)
        .map(([jid, meta]) => ({
          enabled: isAllowedGroup(jid),
          jid,
          size: meta?.participants?.length ?? 0,
          subject: meta?.subject ?? "",
        }))
        .toSorted((a, b) => a.subject.localeCompare(b.subject));
    },
    record: () => record,
    async start() {
      await loadPersisted();
      await reloadOverlay();
      await startSocket();
    },
    async stop() {
      stopped = true;
      await drain();
      clearInterval(flushTimer);
      await flushAll();
      endSocket();
    },
    summary,
  };
};
