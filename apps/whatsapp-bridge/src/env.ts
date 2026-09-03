/**
 * Process-wide configuration, read once at boot.
 *
 * Only what is the same for every account on this Machine lives here: where to
 * listen, where the hub is, where the two directories are, and the media and
 * retry caps. Everything that used to be a Railway variable for one tenant
 * (allowed groups, trigger mode, DM policy, image cap, maintainer and owner
 * JIDs, the bot name) is per-account config in accounts.json instead, so one
 * process can serve two Bots with two numbers without a second deploy.
 *
 * Secrets stay in env or on the volume and never on argv: the hub supervisor
 * passes WHATSAPP_BRIDGE_SECRET and AI_GATEWAY_API_KEY through the child env.
 */

export interface BridgeEnv {
  host: string;
  port: number;
  /** Guards every HTTP route except GET /health. */
  bridgeSecret: string;
  /** Hub base URL; inbound messages POST to `${computerUrl}/connectors/<id>/message`. */
  computerUrl: string;
  /** accounts.json and `<acct>/auth/` Baileys creds. Hub-owned, 0700. */
  stateDir: string;
  /** Per-account message, resource, reaction, participant and lid stores. */
  dataDir: string;
  logLevel: string;
  /** Abort a forward to the hub that hangs; a timeout burns one retry. */
  agentTimeoutMs: number;
  messagesCap: number;
  reactionsCap: number;
  /** How long shutdown waits for in-flight message handlers before closing. */
  shutdownDrainMs: number;
  /** Request WhatsApp's fuller history sync on link. */
  syncFullHistory: boolean;
  maxImageBytes: number;
  docsEnabled: boolean;
  maxDocBytes: number;
  maxPdfPages: number;
  audioEnabled: boolean;
  maxAudioBytes: number;
  maxAudioSeconds: number;
  transcribeTimeoutMs: number;
  maxSendMediaBytes: number;
}

const DEFAULT_STATE_DIR = "/workspace/.computer/whatsapp";
const DEFAULT_DATA_DIR = "/workspace/whatsapp";

/** A positive number from env, else the default. */
const num = (raw: string | undefined, def: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
};

/** "false" turns a feature off; anything else (including unset) leaves it on. */
const flag = (raw: string | undefined): boolean => raw !== "false";

/**
 * Parse the process env. Throws on a missing bridge secret: without it every
 * route would be open to anything on loopback, the model's `shell` included.
 */
export const readEnv = (env: NodeJS.ProcessEnv = process.env): BridgeEnv => {
  const bridgeSecret = env.WHATSAPP_BRIDGE_SECRET?.trim() ?? "";
  if (!bridgeSecret) {
    throw new Error("WHATSAPP_BRIDGE_SECRET is required");
  }
  return {
    agentTimeoutMs: num(env.AGENT_TIMEOUT_MS, 40_000),
    audioEnabled: flag(env.AUDIO_ENABLED),
    bridgeSecret,
    computerUrl: (env.COMPUTER_URL?.trim() || "http://127.0.0.1:8080").replace(/\/+$/u, ""),
    dataDir: env.WHATSAPP_DATA_DIR?.trim() || DEFAULT_DATA_DIR,
    docsEnabled: flag(env.DOCS_ENABLED),
    host: env.HOST?.trim() || "127.0.0.1",
    logLevel: env.LOG_LEVEL?.trim() || "info",
    maxAudioBytes: num(env.MAX_AUDIO_BYTES, 16 * 1024 * 1024),
    maxAudioSeconds: num(env.MAX_AUDIO_SECONDS, 600),
    // The doc cap is 3MB because the file is base64'd into the JSON body (4/3
    // inflation) and the hub ingress caps bodies; a bigger file would be
    // refused before it reached the Bot, so it is skipped here (keeping the
    // [document] placeholder) rather than failing the reply.
    maxDocBytes: num(env.MAX_DOC_BYTES, 3 * 1024 * 1024),
    // Images bigger than this (after WhatsApp's own compression) are skipped;
    // the model provider downsizes large images server-side anyway.
    maxImageBytes: num(env.MAX_IMAGE_BYTES, 4 * 1024 * 1024),
    // Anthropic rejects PDFs over 100 pages, which fails the whole turn.
    maxPdfPages: num(env.MAX_PDF_PAGES, 100),
    maxSendMediaBytes: num(env.MAX_SEND_MEDIA_BYTES, 8 * 1024 * 1024),
    // Messages and reactions get a large cap so a history backfill survives.
    messagesCap: num(env.MESSAGES_CAP, 50_000),
    port: num(env.PORT, 2100),
    reactionsCap: num(env.REACTIONS_CAP, 50_000),
    shutdownDrainMs: num(env.SHUTDOWN_DRAIN_MS, 8000),
    stateDir: env.WHATSAPP_STATE_DIR?.trim() || DEFAULT_STATE_DIR,
    syncFullHistory: flag(env.SYNC_FULL_HISTORY),
    transcribeTimeoutMs: num(env.TRANSCRIBE_TIMEOUT_MS, 30_000),
  };
};
