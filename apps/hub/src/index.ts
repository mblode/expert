import { ClockClient } from "./service/clock.ts";
import { dirname, join, resolve } from "node:path";
import { createHub } from "./app.ts";
import { ensureEveSecret } from "./host/ensure-roster.ts";
import {
  createDesk,
  DockerWindowManager,
  LocalWindowManager,
  NoopWindowManager,
} from "./desk/index.ts";
import { allowedBind, refuseBindMessage } from "./host/bind.ts";
import { profileSeeds } from "./host/bot-seed.ts";
import { templateSources } from "./host/bot-template.ts";
import { eveUrlForDisplay, resolveEveBotsRoot } from "./host/eve.ts";
import { awakeUntil, botWaker, keepAwake } from "./host/wake.ts";
import { readRoutines, routineAlarm } from "./host/routines.ts";
import { loadPolicy } from "./service/policy.ts";
import { FileBotStore } from "./service/provision.ts";
import { FilePrincipalStore } from "./service/principals.ts";
import { FileConnectorStore } from "./service/connectors.ts";
import { FileConversationStore, FileMessageLog } from "./service/conversations.ts";
import { FileCodingIntentStore } from "./service/coding-intents.ts";
import { BridgeClient, DEFAULT_BRIDGE_URL } from "./service/whatsapp.ts";
import { PixelRegistry } from "./service/pixels.ts";

// Where the Bots' Eve projects are, resolved exactly as the supervisor does
// it: the hub reads `agent/profile.json` from the same tree, so a Bot's name,
// label and mark come from the directory that is the agent.
const botsRoot = resolveEveBotsRoot({
  envBots: process.env.COMPUTER_EVE_BOTS,
  imageBots: resolve(import.meta.dirname, "../../eve/bots"),
});

/** Seconds in the environment, milliseconds in the code, unset means default. */
function idleMs(name: string): number | undefined {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined;
}

const bind = process.env.COMPUTER_BIND ?? "127.0.0.1";
if (!allowedBind(bind)) {
  console.error(refuseBindMessage(bind));
  process.exit(1);
}

const port = Number(process.env.COMPUTER_PORT ?? 8787);
const publicUrl = process.env.COMPUTER_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const vncUrl =
  process.env.COMPUTER_VNC_URL ?? `${publicUrl.replace(/\/$/, "")}/vnc/index.html?view_only=1`;
const deskMode = process.env.COMPUTER_DESK ?? "fake";
// Paired seats and policy live beside the roster, wherever the operator put it.
const rosterPath = resolve(process.env.COMPUTER_DATA ?? "data/bots.json");
const dataDir = dirname(rosterPath);
// The guest hands this in (`/run/computer/wake`, hub-owned); off the guest it
// sits beside the roster, where `npm run up`'s supervisor also looks.
const wakeDir = process.env.COMPUTER_WAKE_DIR ?? join(dataDir, "wake");
const eveSecret = ensureEveSecret(join(dataDir, "eve-secret"), process.env.COMPUTER_EVE_SECRET);
// The bridge's admin secret lives beside the roster and is handed to the
// bridge child by the supervisor; the hub reads the same file. Same shape as
// the Eve secret, and for the same reason: never on argv, never in a log.
const bridgeSecret = ensureEveSecret(
  join(dataDir, "whatsapp", "bridge-secret"),
  process.env.WHATSAPP_BRIDGE_SECRET,
);

const windows =
  deskMode === "docker"
    ? new DockerWindowManager(process.env.COMPUTER_DESK_CONTAINER ?? "computer-desk")
    : deskMode === "local"
      ? new LocalWindowManager()
      : new NoopWindowManager();

const paAccount = process.env.COMPUTER_PA_ACCOUNT?.trim();
const paJid = process.env.COMPUTER_PA_OWNER_JID?.trim();
if (
  (paAccount || paJid) &&
  (!paAccount ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/.test(paAccount) ||
    !paJid ||
    !/^[0-9]+@(s\.whatsapp\.net|lid)$/.test(paJid))
) {
  throw new Error("configure both COMPUTER_PA_ACCOUNT and the exact COMPUTER_PA_OWNER_JID");
}
const clockUrl = process.env.COMPUTER_CLOCK_URL;
const clockTenant = process.env.COMPUTER_CLOCK_TENANT;
const clockSecret = process.env.COMPUTER_CLOCK_SECRET;
if (paAccount && (!clockUrl || !clockTenant || !clockSecret || clockSecret.length < 32)) {
  throw new Error("personal assistant mode requires a configured durable wake clock");
}
const hub = createHub({
  paRepos: (process.env.COMPUTER_PA_REPOS ?? "")
    .split(/[,\n]/u)
    .map((repo) => repo.trim())
    .filter(Boolean),
  clock:
    clockUrl && clockTenant && clockSecret
      ? new ClockClient(clockUrl, clockTenant, clockSecret)
      : undefined,
  paOwner: paAccount && paJid ? { acct: paAccount, jid: paJid } : undefined,
  setupCode: process.env.COMPUTER_SETUP_CODE ?? "",
  deskFactory: createDesk,
  windows,
  store: new FileBotStore(rosterPath),
  principalStore: new FilePrincipalStore(join(dataDir, "seats.json")),
  pixels: new PixelRegistry({
    tokenDir: process.env.COMPUTER_VNC_TOKEN_DIR ?? join(dataDir, "vnc-tokens"),
    ttlMs: Number(process.env.COMPUTER_VNC_TTL_SEC ?? 900) * 1000,
  }),
  policy: loadPolicy(join(dataDir, "policy.json")),
  connectorStore: new FileConnectorStore(join(dataDir, "connectors.json")),
  // Hub-owned, beside the roster. Deliberately not `/workspace/.bots`, which
  // the model's `shell` and `write_file` run as `box` can rewrite.
  conversationStore: new FileConversationStore(join(dataDir, "conversations.json")),
  assistantStorePath: join(dataDir, "assistant-revisions.json"),
  inboundStorePath: join(dataDir, "inbound.json"),
  turnStorePath: join(dataDir, "turns.json"),
  codingIntents: new FileCodingIntentStore(join(dataDir, "coding-intents.json")),
  messageLog: new FileMessageLog(join(dataDir, "conversations")),
  bridge: new BridgeClient({
    secret: bridgeSecret,
    url: process.env.COMPUTER_BRIDGE_URL ?? DEFAULT_BRIDGE_URL,
  }),
  // A Bot with a live wake marker is at work, whether or not it is touching
  // its screen, so the sweep leaves that screen alone.
  botBusy: (botId) => awakeUntil(wakeDir, botId) > Date.now(),
  // The same question asked of the whole box, for `/healthz`: `apps/clock`
  // wakes this Machine for a routine and needs to know when the turn it woke
  // is over, because Fly Proxy suspends on idle traffic and a routine makes
  // none. Every Bot, not just the sleeping ones: the primary Bot has no
  // marker of its own, so its `wake` touches are what say it is working.
  busy: () => {
    const at = Date.now();
    return hub.bots.all().some((bot) => awakeUntil(wakeDir, bot.id) > at);
  },
  profileSeed: profileSeeds(botsRoot),
  screenIdleMs: idleMs("COMPUTER_SCREEN_IDLE_SEC"),
  statusFile: process.env.COMPUTER_STATUS_FILE,
  // The half of a template that is in git: a shipped Bot's brief, skills,
  // routines and connections. Read from the same root the seeds come from.
  templateSource: templateSources(botsRoot),
  vncUrl,
  // Sleeping Bots: the hub writes down who should be awake, the supervisor
  // that owns the children reads it. `host/wake.ts` has the whole protocol.
  wake: botWaker({
    awakeMs: idleMs("COMPUTER_BOT_AWAKE_SEC"),
    dir: wakeDir,
    eveUrl: (_botId, display) => process.env.COMPUTER_EVE_URL ?? eveUrlForDisplay(display),
  }),
  vncHost: process.env.COMPUTER_VNC_HOST ?? "127.0.0.1",
  // RFB port for window N is base + N (primary :1 → 5901).
  vncBasePort: Number(process.env.COMPUTER_VNC_PORT ?? 5900),
  eveSecret,
});

await hub.start();

// A sleeping Bot cannot fire its own cron, so the hub wakes it a minute
// before one is due and its Eve fires the routine itself. `host/routines.ts`
// explains why the schedule is written down twice and what keeps the two
// copies honest.
const alarm = routineAlarm({
  bots: hub.bots.all().map((bot) => ({ botId: bot.id, routines: readRoutines(botsRoot, bot.id) })),
  keepAwake: (botId, untilMs) => {
    try {
      keepAwake(wakeDir, botId, untilMs);
    } catch {
      // Nowhere to write means nothing sleeps here either.
    }
  },
  onEvent: (line) => console.log(`computer ${line}`),
});

hub.server.listen(port, bind, () => {
  console.log(`computer hub on http://${bind}:${port}`);
  console.log(`vncUrl ${vncUrl}`);
  console.log(
    `bots ${hub.bots
      .all()
      .map((b) => `${b.id}:${b.display}`)
      .join(" ")}`,
  );
});

const shutdown = (): void => {
  alarm();
  void hub.close().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
