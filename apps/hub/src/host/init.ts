/**
 * The Fly guest's init: root under tini, the only process on the box that
 * changes uid. It owns the volume fixups, the secrets, the roster, and the
 * supervisor that runs everything else as the right user:
 *
 *   desk-up (box, once) → Eve per Bot (box) → the WhatsApp bridge (hub) → the hub (hub)
 *
 * The hub is no longer `box` (AUDIT P0 #2): what the model's `shell` can read
 * is what box can read, and the roster, seat tokens, connector secrets and
 * Baileys credentials are now hub-owned at 0700. The hub runs desk commands
 * as box through `sudo -u box` (one sudoers line in the image). Everything
 * under /workspace that the Bot works in is still box's.
 *
 * Env comes from the Fly config and secrets. Nothing secret goes on argv.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { ensureEveSecret, ensureRosterAt } from "./ensure-roster.ts";
import { eveProjectIds, planEveLaunches, resolveEveBotsRoot, superviseEves } from "./eve.ts";
import { watchWake } from "./wake.ts";
import { watchRoster } from "./adopt.ts";
import { FileBotStore } from "../service/provision.ts";
import { Supervisor } from "./supervisor.ts";

/**
 * Four levels up from `apps/hub/src/host`, and checked rather than trusted.
 *
 * This was three, which resolved to `<root>/apps`, and every use of it below
 * degrades in silence when it is wrong: `bridgeDir` pointed at
 * `apps/apps/whatsapp-bridge`, so the `existsSync` guard read a missing
 * directory as "no bridge on this image" and the WhatsApp bridge never
 * started on the guest at all. `imageBots` missed the same way, which only
 * stayed invisible because a populated volume overlay wins first. A wrong
 * root is a boot failure now, not a quieter computer.
 */
const repoRoot = resolve(import.meta.dirname, "../../../..");
const { env } = process;

if (!existsSync(join(repoRoot, "package.json"))) {
  console.error(
    `computer init: no package.json at ${repoRoot}, so this build's layout is not what init expects. Refusing to boot a computer that would silently skip the bridge and the image Bots.`,
  );
  process.exit(1);
}

const cloud = env.COMPUTER_CLOUD ?? "";
const hubPort = env.COMPUTER_PORT ?? "8080";
const hubUrl = env.COMPUTER_URL ?? `http://127.0.0.1:${hubPort}`;
const rosterPath = resolve(env.COMPUTER_DATA ?? "/workspace/.computer/bots.json");
const dataDir = dirname(rosterPath);
const runDir = env.COMPUTER_RUN_DIR ?? "/run/computer";
const statusFile = env.COMPUTER_STATUS_FILE ?? join(runDir, "status.json");
// Where the hub says which Bots should be awake. Root writes the directory
// and hands it to the hub group; the hub writes one small file per Bot and
// this process reads them. See `host/wake.ts`.
const wakeDir = env.COMPUTER_WAKE_DIR ?? join(runDir, "wake");
const logDir = env.COMPUTER_LOG_DIR ?? join(dataDir, "logs");
const bridgePort = env.COMPUTER_BRIDGE_PORT ?? "2100";
const bridgeDir = join(repoRoot, "apps/whatsapp-bridge");
const workspace = "/workspace";

const box = ids(env.COMPUTER_BOX_USER ?? "box");
const hub = ids(env.COMPUTER_HUB_USER ?? "hub");
const isRoot = process.getuid?.() === 0;

/** `id -u`/`id -g` for a user; falls back to the current user off the guest (tests, `npm run up`). */
function ids(name: string): { uid: number; gid: number; name: string } {
  const uid = spawnSync("id", ["-u", name], { encoding: "utf-8" });
  const gid = spawnSync("id", ["-g", name], { encoding: "utf-8" });
  if (uid.status === 0 && gid.status === 0) {
    return { gid: Number(gid.stdout.trim()), name, uid: Number(uid.stdout.trim()) };
  }
  const me = userInfo();
  return { gid: me.gid, name: me.username, uid: me.uid };
}

function own(path: string, who: { uid: number; gid: number }, mode?: number): void {
  if (!isRoot) {
    return;
  }
  chownSync(path, who.uid, who.gid);
  if (mode !== undefined) {
    spawnSync("chmod", [mode.toString(8), path]);
  }
}

// 1. The volume mounts root-owned. Only its top level and the hub's own
//    state dir are fixed up: a recursive chown over a large workspace on
//    every boot would outlast the health-check grace period.
mkdirSync(dataDir, { mode: 0o700, recursive: true });
own(workspace, box, 0o755);
own(dataDir, hub, 0o700);
for (const sub of ["whatsapp", "logs", "vnc-tokens"]) {
  const p = join(dataDir, sub);
  mkdirSync(p, { mode: 0o700, recursive: true });
  own(p, hub, 0o700);
}
const bridgeData = join(workspace, "whatsapp");
mkdirSync(bridgeData, { mode: 0o755, recursive: true });
own(bridgeData, hub, 0o755);
if (existsSync("/home/box")) {
  spawnSync("chown", ["-R", `${box.uid}:${box.gid}`, "/home/box"]);
}

// 2. The pairing code. On a cloud it must be a platform secret: a code on
//    the volume was readable by the model until the uid split, and even now
//    it is a permanent owner credential nobody rotates. Off the cloud, mint
//    one so `npm run up` still pairs.
let setupCode = env.COMPUTER_SETUP_CODE ?? "";
if (!setupCode) {
  const codePath = join(dataDir, "setup-code");
  if (cloud && env.COMPUTER_ALLOW_MINTED_SETUP_CODE !== "1") {
    console.error(
      "computer init: COMPUTER_SETUP_CODE is not set. Set it as a platform secret (fly secrets set COMPUTER_SETUP_CODE=...) and redeploy. Refusing to mint one onto the volume.",
    );
    process.exit(1);
  }
  if (existsSync(codePath)) {
    setupCode = readFileSync(codePath, "utf-8").trim();
  } else {
    setupCode = randomBytes(16).toString("hex");
    writeFileSync(codePath, `${setupCode}\n`, { mode: 0o600 });
    own(codePath, hub);
    console.warn("computer init: minted a setup code onto the volume (not a cloud deployment)");
  }
}

// 3. Secrets and the roster, hub-owned. Written here as root, then handed over.
const eveSecret = ensureEveSecret(join(dataDir, "eve-secret"), env.COMPUTER_EVE_SECRET);
const bridgeSecret = ensureEveSecret(
  join(dataDir, "whatsapp", "bridge-secret"),
  env.WHATSAPP_BRIDGE_SECRET,
);
// Which Bots this build ships is a property of the tree, so the Eve root is
// resolved before the roster rather than after it: every project with no
// roster row gets one here, on the lowest free screen, and adding a Bot is a
// deploy instead of a deploy plus a `CreateBot` against the running guest.
const imageBots = join(repoRoot, "apps/eve/bots");
const botsRoot = resolveEveBotsRoot({ envBots: env.COMPUTER_EVE_BOTS, imageBots });
// Only a tree this build shipped may mint a Bot. The overlay
// (`/workspace/eve/bots`) is on the volume, which `box` owns, so the model's
// own `write_file` reaches it: seeding from there would turn a directory the
// model can create into a roster row, a minted agent token and one of the
// eight screens. The overlay still replaces a Bot's code, which is what it is
// for; it just cannot bring a Bot into existence.
const trustedBots = botsRoot === imageBots || botsRoot === env.COMPUTER_EVE_BOTS;
const roster = ensureRosterAt(rosterPath, trustedBots ? eveProjectIds(botsRoot) : []);
for (const f of [
  "eve-secret",
  "bots.json",
  "seats.json",
  "connectors.json",
  "policy.json",
  "whatsapp/bridge-secret",
]) {
  const p = join(dataDir, f);
  if (existsSync(p)) {
    own(p, hub, 0o600);
  }
}

// 4. Eve state on the volume. `eve start` keeps durable runs under
//    `<project>/.eve/.workflow-data`; for the image Bots that is the image,
//    which a redeploy replaces. Point it at the volume so a parked turn
//    survives a deploy. The overlay under /workspace is already there.
if (trustedBots) {
  for (const id of safeReaddir(botsRoot)) {
    const project = join(botsRoot, id);
    if (!existsSync(join(project, "package.json"))) {
      continue;
    }
    const target = join(workspace, ".bots", id, "eve-state", "workflow-data");
    const link = join(project, ".eve", ".workflow-data");
    mkdirSync(target, { recursive: true });
    own(join(workspace, ".bots"), box, 0o755);
    own(join(workspace, ".bots", id), box, 0o755);
    own(join(workspace, ".bots", id, "eve-state"), box, 0o755);
    own(target, box, 0o755);
    mkdirSync(dirname(link), { recursive: true });
    own(dirname(link), box);
    let existing;
    try {
      existing = lstatSync(link);
    } catch {
      try {
        symlinkSync(target, link);
      } catch (error) {
        // Parking Eve state on the volume is a convenience. Letting the
        // symlink throw out of here is PID 1 refusing to boot the computer
        // over it, so it warns like every other degradation in this block.
        console.warn(
          `computer init: could not link ${link} to the volume (${(error as Error).message})`,
        );
      }
      continue;
    }
    if (!existing.isSymbolicLink()) {
      // A real directory from an earlier boot: leave it, say so, move on.
      console.warn(`computer init: ${link} is a directory, not linking it to the volume`);
    }
  }
}

// 5. Children. Both hub-owned children below run with HOME here, and
//    `sup.start` forks and execs synchronously, so the directory has to exist
//    and belong to `hub` before the first of them is spawned, not after.
mkdirSync(logDir, { mode: 0o700, recursive: true });
own(logDir, hub, 0o700);
// 0770 and hub-owned: the hub writes the markers, root reads them, and the
// model (box) sees neither. A Bot cannot vote on whether it is awake.
mkdirSync(wakeDir, { mode: 0o770, recursive: true });
own(wakeDir, hub, 0o770);
mkdirSync(join(dataDir, "home"), { mode: 0o700, recursive: true });
own(join(dataDir, "home"), hub, 0o700);

const sup = new Supervisor({
  onEvent: (line) => console.log(`computer ${line}`),
  statusFile,
});

/**
 * The login's worth for box children, plus the model keys Eve needs. Never the
 * setup code or the bridge secret: Eve shares uid box with the model's `shell`,
 * so anything in its environ is the model's too. WhatsApp reaches Eve through
 * the hub's connector door with the Eve secret; a Bot that needs to call the
 * bridge back gets that account's own `bridge_secret`, which the bridge now
 * mints per account, and never this admin one. Handing it to the Eve child is
 * still to do, and the ordering is the catch: the bridge mints a missing
 * secret at its own boot, which is after the Eve children below are planned.
 */
const DENY = new Set([
  "COMPUTER_SETUP_CODE",
  "WHATSAPP_BRIDGE_SECRET",
  "FLY_API_TOKEN",
  // The coding runner's key. It can write to every repository the token can
  // see, the hub calls the runner itself, and no child needs it: in an Eve
  // environ it is a credential the model can lift out of /proc, which is the
  // same failure delegating the work off the box exists to avoid.
  "CURSOR_API_KEY",
]);
function childEnv(extra: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!DENY.has(k) && v !== undefined) {
      out[k] = v;
    }
  }
  return { ...out, HOME: home, ...extra };
}

sup.start({
  args: [],
  cmd: "/usr/local/bin/desk-up",
  env: childEnv({ USER: box.name }, "/home/box"),
  gid: box.gid,
  id: "desk",
  log: join(logDir, "desk.log"),
  oneShot: true,
  uid: box.uid,
});

// The primary Bot is always running: it is the desk agent, the default route
// and the one a human reaches without asking for anyone. Every other Bot is
// registered asleep and started when the hub says it is wanted, because an
// Eve is 224 MB and eight of them do not fit beside a desktop on a 2 GB
// guest. `wakeDir` is the whole conversation between the two processes.
const eves = planEveLaunches(roster, { botsRoot });
// From the launches, not the roster: if the display-1 row names a Bot this
// build ships no project for, taking its id here would mark every Bot lazy
// and boot a computer with nothing running and `/healthz` calling that fine.
const primaryBotId = eves.find((e) => e.display === 1)?.botId ?? eves[0]?.botId ?? "main";
superviseEves(sup, eves, {
  env: childEnv({ USER: box.name }, "/home/box"),
  eveSecret,
  gid: box.gid,
  hubUrl,
  lazy: (botId) => botId !== primaryBotId,
  logDir,
  uid: box.uid,
});
// Every Bot that sleeps, which is every Bot but the primary one. A set
// rather than a list because it grows: a Bot made from `Seat.CreateBot`
// after boot is adopted into it below.
const sleeping = new Set(eves.map((e) => e.botId).filter((id) => id !== primaryBotId));
const stopWatchingWake = watchWake({
  botIds: () => [...sleeping],
  dir: wakeDir,
  onEvent: (line) => console.log(`computer ${line}`),
  sup,
});
// A Bot can also be made while the computer is running, and that Bot has no
// directory in the image: it runs the template project, and its name, label
// and description, which the hub folds into its prompt, are what make it
// itself. Without this it is a roster row with no process, answering
// DAEMON_DOWN forever.
const stopWatchingRoster = watchRoster({
  onAdopt: (bot) => {
    const launches = planEveLaunches([bot], { botsRoot });
    if (launches.length === 0) {
      console.warn(`computer roster: bot ${bot.id} has no project and no template; it cannot run`);
      return;
    }
    superviseEves(sup, launches, {
      env: childEnv({ USER: box.name }, "/home/box"),
      eveSecret,
      gid: box.gid,
      hubUrl,
      lazy: () => true,
      logDir,
      uid: box.uid,
    });
    sleeping.add(bot.id);
    console.log(`computer roster: adopted bot ${bot.id} on screen ${bot.display}`);
  },
  onEvent: (line) => console.log(`computer ${line}`),
  read: () => new FileBotStore(rosterPath).load(),
  seen: roster.map((r) => r.id),
});
if (eves.length === 0) {
  console.warn(`computer init: no Eve project under ${botsRoot}; chat will report DAEMON_DOWN`);
}

// Opt-in, not opt-out. Fixing `repoRoot` above makes this directory
// reachable for the first time, so a default-on bridge would start
// unannounced on the next deploy, and `/healthz` reports the supervisor's
// view while fly.toml health-checks the guest on it every 30s. A bridge that
// cannot come up would take the Machine down with it. Set
// COMPUTER_WHATSAPP=on once it has been watched starting on a guest.
if (env.COMPUTER_WHATSAPP === "on" && existsSync(join(bridgeDir, "package.json"))) {
  sup.start({
    args: ["run", "start", "--workspace=apps/whatsapp-bridge"],
    cmd: "npm",
    cwd: repoRoot,
    env: childEnv(
      {
        COMPUTER_URL: hubUrl,
        HOST: "127.0.0.1",
        PORT: bridgePort,
        USER: hub.name,
        WHATSAPP_BRIDGE_SECRET: bridgeSecret,
        WHATSAPP_DATA_DIR: bridgeData,
        WHATSAPP_STATE_DIR: join(dataDir, "whatsapp"),
      },
      join(dataDir, "home"),
    ),
    gid: hub.gid,
    healthUrl: `http://127.0.0.1:${bridgePort}/health`,
    id: "whatsapp-bridge",
    log: join(logDir, "whatsapp-bridge.log"),
    uid: hub.uid,
  });
}

sup.start({
  args: ["run", "start", "--workspace=apps/hub"],
  cmd: "npm",
  cwd: repoRoot,
  env: childEnv(
    {
      COMPUTER_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
      COMPUTER_EVE_SECRET: eveSecret,
      COMPUTER_RUN_AS: box.name,
      COMPUTER_SETUP_CODE: setupCode,
      COMPUTER_STATUS_FILE: statusFile,
      COMPUTER_WAKE_DIR: wakeDir,
      USER: hub.name,
      WHATSAPP_BRIDGE_SECRET: bridgeSecret,
    },
    join(dataDir, "home"),
  ),
  gid: hub.gid,
  // /spec is public and answers only once the hub is listening; /healthz
  // would read this supervisor's own status, which is circular.
  healthUrl: `http://127.0.0.1:${hubPort}/spec`,
  id: "hub",
  log: join(logDir, "hub.log"),
  uid: hub.uid,
});

console.log(
  `computer init: desk, ${eves.length} eve, bridge and hub under supervision; status at ${statusFile}`,
);

const shutdown = (): void => {
  stopWatchingWake();
  stopWatchingRoster();
  void sup.stopAll().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
