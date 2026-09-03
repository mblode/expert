#!/usr/bin/env node
/**
 * computer: the box in one command.
 *
 *   npm run up               build the desk, start the hub, print the pairing QR
 *   npm run bot -- new night provision a Bot on the fly (next free screen, token shown once)
 *   npm run bot -- ls        list Bots and their screens
 *   npm run bot -- rm night  delete a Bot, free its screen
 *   npm run bot -- token id  reprint a Bot's token from the local roster
 *   npm run qr               reprint the pairing QR
 *
 * No config to write. `.env` is generated on first `up`; the only secret
 * you ever see is printed exactly when you need it.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

const root = resolve(import.meta.dirname, "..");
/** First Eve listens here; display N uses EVE_BASE_PORT + (N - 1). Mirrors apps/hub/src/host/eve.ts. */
const EVE_BASE_PORT = 2000;
const envPath = resolve(root, ".env");

const [cmd, ...args] = process.argv.slice(2);

const USAGE = [
  "usage:",
  "  npm run up                 start everything, print the pairing QR",
  "  npm run qr                 reprint the pairing QR",
  "  npm run bot -- new <id>    provision a Bot (token shown once)",
  "  npm run bot -- ls [--json] list Bots",
  "  npm run bot -- rm <id>     delete a Bot",
  "  npm run bot -- token <id>  reprint a Bot's token from the local roster",
  "  npm run bot -- channel add|ls|rotate|rm <id> [kind] [bot]  channel doors (channels.json)",
].join("\n");

try {
  switch (cmd) {
    case "up": {
      await up();
      break;
    }
    case "qr": {
      printPairing(loadEnv());
      break;
    }
    case "bot": {
      await bot(args);
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      console.log(USAGE);
      break;
    }
    default: {
      console.error(`unknown command: ${cmd}\n${USAGE}`);
      process.exit(1);
    }
  }
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

async function up() {
  const env = ensureEnv();
  // Per-run overrides. Never written back to .env: a Docker daemon that was
  // down once must not leave the box on a fake desk for good.
  const run = { ...env };

  // 1. Desk container (skipped gracefully without a running Docker).
  if (dockerReady()) {
    console.log("• building the desk (first run takes a few minutes)…");
    exec("docker", ["compose", "up", "-d", "--build", "--force-recreate"]);
  } else if (has("docker")) {
    console.log(
      "• docker is installed but its daemon is not running, start Docker Desktop or OrbStack, then re-run `npm run up`",
    );
    console.log("  continuing with a fake desk so you can still pair and poke around");
    run.COMPUTER_DESK = "fake";
  } else {
    console.log(
      "• docker not found: running with a fake desk (install Docker or OrbStack for the real thing)",
    );
    run.COMPUTER_DESK = "fake";
  }

  // 2. Publish over Tailscale when available.
  if (has("tailscale")) {
    try {
      exec("tailscale", ["serve", "--bg", `http://127.0.0.1:${env.COMPUTER_PORT}`]);
      const status = JSON.parse(capture("tailscale", ["status", "--json"]));
      const dns = status?.Self?.DNSName?.replace(/\.$/, "");
      if (dns) {
        env.COMPUTER_PUBLIC_URL = `https://${dns}`;
        run.COMPUTER_PUBLIC_URL = env.COMPUTER_PUBLIC_URL;
      }
      console.log(`• published via Tailscale Serve: ${env.COMPUTER_PUBLIC_URL}`);
    } catch {
      console.log(
        "• tailscale serve failed: pairing will use the local URL; run `tailscale up` and retry",
      );
    }
  } else {
    console.log(
      "• tailscale not found: pairing will only work on this machine (https://tailscale.com/download)",
    );
  }
  saveEnv(env);

  // 3. One Eve process per roster bot that has apps/eve/bots/<id>.
  //    Loopback only; the hub proxies /eve/v1 so clients know one origin.
  const eve = startEve(run);

  // 4. Pairing QR, then the hub in the foreground.
  printPairing(env);
  console.log("• starting the hub (ctrl-c stops it; the desk keeps running)…\n");
  const child = spawn("npx", ["tsx", "apps/hub/src/index.ts"], {
    cwd: root,
    env: { ...process.env, ...run },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    // Ctrl-c already reached the supervisor through the process group; this
    // is for the hub dying on its own. Best effort only, npx may not forward
    // the signal, which is what the port check on the next `up` is for.
    eve?.kill();
    process.exit(code ?? 0);
  });
}

/**
 * The supervisor the guest's PID 1 runs, minus the children a dev machine
 * does not have: one `eve start` per roster bot, restarted with backoff and
 * probed on /eve/v1/health. It shares this process group, so ctrl-c on the
 * hub stops the Eves with it.
 */
function startEve(env) {
  const mainDir = resolve(root, "apps/eve/bots/main");
  if (!existsSync(resolve(mainDir, "package.json"))) {
    console.log("• no apps/eve/bots/main: copy that dir, mint a token, then re-run `up`");
    return null;
  }
  if (!process.env.AI_GATEWAY_API_KEY && !env.AI_GATEWAY_API_KEY) {
    console.log("• AI_GATEWAY_API_KEY is unset: Eve will start but model calls will fail");
  }
  if (portInUse(EVE_BASE_PORT)) {
    console.log(
      `• an Eve process is already listening on :${EVE_BASE_PORT} from a previous \`up\`; leaving it`,
    );
    return null;
  }
  // The supervisor mirrors its view here and the hub's /healthz reads it, so
  // a dead Eve is as visible locally as it is on the guest. Only a run that
  // owns the supervisor points the hub at it: /healthz calls a file nobody
  // refreshes stale, and reports the whole box down for it.
  env.COMPUTER_STATUS_FILE ??= resolve(root, env.COMPUTER_DATA ?? "data/bots.json").replace(
    /bots\.json$/,
    "status.json",
  );
  const eve = spawn("npx", ["tsx", "apps/hub/src/host/eves.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      COMPUTER_URL: env.COMPUTER_URL ?? `http://127.0.0.1:${env.COMPUTER_PORT}`,
    },
    stdio: "inherit",
  });
  eve.on("error", () => console.log("• eve supervisor failed: chat will show Eve as not running"));
  return eve;
}

async function bot(argv) {
  const [sub, id] = argv;
  const env = loadEnv();
  switch (sub) {
    case "new": {
      requireId(id);
      const r = await seatRpc(env, "/computer.v1.Seat/CreateBot", { id });
      console.log(`Bot ${r.id} is live on screen ${r.display}.`);
      console.log("");
      console.log(`  token: ${r.token}`);
      console.log("");
      console.log("This token is the Bot's identity. Give it a brain: copy apps/eve/bots/main");
      console.log(
        `→ apps/eve/bots/${id}, customise agent/instructions.md, skills/, schedules/, then restart.`,
      );
      console.log(
        `Port is ${EVE_BASE_PORT} + (display - 1) = ${EVE_BASE_PORT + Number(r.display) - 1}.`,
      );
      break;
    }
    case "rm": {
      requireId(id);
      await seatRpc(env, "/computer.v1.Seat/DeleteBot", { id });
      console.log(`Bot ${id} deleted; its screen is free.`);
      break;
    }
    case "ls": {
      const s = await seatRpc(env, "/computer.v1.Seat/Status", {});
      if (argv.includes("--json")) {
        console.log(JSON.stringify(s.screens ?? [], null, 2));
        break;
      }
      for (const screen of s.screens ?? []) {
        console.log(`${screen.bot_id}\tscreen ${screen.display}\t${screen.state}`);
      }
      break;
    }
    case "token": {
      requireId(id);
      const store = JSON.parse(
        readFileSync(resolve(root, env.COMPUTER_DATA ?? "data/bots.json"), "utf-8"),
      );
      const entry = store.find((b) => b.id === id);
      if (!entry) {
        throw new Error(`no bot ${id}, run \`npm run bot -- ls\``);
      }
      console.log(entry.token);
      break;
    }
    case "channel": {
      channel(argv.slice(1), env);
      break;
    }
    default: {
      throw new Error("usage: npm run bot -- new|ls|rm|token|channel [id]");
    }
  }
}

/**
 * Channel doors, straight in the hub's channels.json (same record shape as
 * apps/hub/src/service/channels.ts). The secret prints once on add or
 * rotate and never again: a bridge or webhook is configured with it there
 * and then, and a lost one is rotated, not recovered.
 */
function channel(argv, env) {
  const [sub, id, kind, botId] = argv;
  const path = resolve(root, env.COMPUTER_DATA ?? "data/bots.json").replace(
    /bots\.json$/,
    "channels.json",
  );
  const load = () => (existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : []);
  const save = (records) =>
    writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  const mint = () => randomBytes(32).toString("base64url");
  switch (sub) {
    case "ls": {
      for (const r of load()) {
        console.log(`${r.id}\t${r.kind}\tbot ${r.bot}\t${(r.paths ?? []).join(",") || "any path"}`);
      }
      break;
    }
    case "add": {
      if (!id || !kind) {
        throw new Error("usage: npm run bot -- channel add <id> <kind> [bot]");
      }
      const records = load();
      if (records.some((r) => r.id === id)) {
        throw new Error(`channel ${id} exists; use rotate`);
      }
      const record = {
        bot: botId ?? "main",
        created_at: new Date().toISOString(),
        id,
        kind,
        paths: kind === "whatsapp" ? ["/eve/v1/whatsapp/message"] : undefined,
        secret: mint(),
      };
      save([...records, record]);
      console.log(`channel ${id} (${kind}) → bot ${record.bot}`);
      console.log("");
      console.log(`  secret: ${record.secret}`);
      console.log("");
      console.log(
        `POST /channels/${id}/<path> with header x-channel-secret. Shown once; rotate to replace.`,
      );
      break;
    }
    case "rotate": {
      if (!id) {
        throw new Error("usage: npm run bot -- channel rotate <id>");
      }
      const records = load();
      const record = records.find((r) => r.id === id);
      if (!record) {
        throw new Error(`no channel ${id}`);
      }
      record.secret = mint();
      save(records);
      console.log(`  secret: ${record.secret}`);
      break;
    }
    case "rm": {
      if (!id) {
        throw new Error("usage: npm run bot -- channel rm <id>");
      }
      save(load().filter((r) => r.id !== id));
      console.log(`channel ${id} removed`);
      break;
    }
    default: {
      throw new Error("usage: npm run bot -- channel add|ls|rotate|rm [id] [kind] [bot]");
    }
  }
}

function requireId(id) {
  if (!id) {
    throw new Error("bot id required, e.g. `npm run bot -- new night`");
  }
}

// --- pairing / rpc ---

/**
 * A Seat call as this CLI. The seat token is paired once and kept in .env:
 * pairing per command minted a durable token every time and never revoked it.
 */
async function seatRpc(env, path, body) {
  if (env.COMPUTER_SEAT_TOKEN) {
    try {
      return await rpc(env, path, body, env.COMPUTER_SEAT_TOKEN);
    } catch (error) {
      if (!/seat token|UNAUTHENTICATED/i.test(String(error?.message))) throw error;
      // The hub forgot it (a fresh data dir). Pair again below.
    }
  }
  env.COMPUTER_SEAT_TOKEN = await pairSeat(env);
  saveEnv(env);
  return rpc(env, path, body, env.COMPUTER_SEAT_TOKEN);
}

async function pairSeat(env) {
  try {
    const r = await rpc(env, "/computer.v1.Seat/Pair", { code: env.COMPUTER_SETUP_CODE });
    return r.token;
  } catch (error) {
    if (/setup code/i.test(String(error?.message))) {
      throw new Error(
        ".env's COMPUTER_SETUP_CODE does not match the running hub: restart it with `npm run up`",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

async function rpc(env, path, body, token) {
  const base = `http://127.0.0.1:${env.COMPUTER_PORT}`;
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      method: "POST",
    });
  } catch {
    throw new Error(`hub is not running on ${base}, start it with \`npm run up\``);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (!res.ok) {
    throw new Error(json?.error?.message ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

function printPairing(env) {
  const payload = `computer://pair?host=${encodeURIComponent(env.COMPUTER_PUBLIC_URL)}&code=${encodeURIComponent(env.COMPUTER_SETUP_CODE)}`;
  console.log("\nScan from Computer.app (or paste the code):\n");
  qr(payload);
  console.log(`  host: ${env.COMPUTER_PUBLIC_URL}`);
  console.log(`  code: ${env.COMPUTER_SETUP_CODE}\n`);
}

function qr(text) {
  try {
    // Optional pretty-printer; the URL below always works without it.
    require("qrcode-terminal").generate(text, { small: true });
  } catch {
    console.log(`  ${text}\n`);
  }
}

// --- env file ---

function ensureEnv() {
  const env = loadEnv(false);
  env.COMPUTER_BIND ??= "127.0.0.1";
  env.COMPUTER_PORT ??= "8787";
  env.COMPUTER_SETUP_CODE ??= randomBytes(9).toString("base64url");
  env.COMPUTER_PUBLIC_URL ??= `http://127.0.0.1:${env.COMPUTER_PORT}`;
  env.COMPUTER_DESK ??= "docker";
  env.COMPUTER_DATA ??= "data/bots.json";
  saveEnv(env);
  return env;
}

function loadEnv(required = true) {
  if (!existsSync(envPath)) {
    if (required) {
      throw new Error("no .env yet, run `npm run up` first");
    }
    return {};
  }
  const env = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) {
      const [, key, value] = m;
      env[key] = value;
    }
  }
  if (required && !env.COMPUTER_SETUP_CODE) {
    throw new Error(".env has no COMPUTER_SETUP_CODE, run `npm run up` to generate one");
  }
  return env;
}

function saveEnv(env) {
  const lines = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
}

// --- shell ---

function has(bin) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `docker --version` succeeds with the daemon down; `docker info` does not. */
function dockerReady() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function portInUse(port) {
  try {
    // Linux and macOS both ship lsof; a missing binary reads as "free".
    execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function exec(bin, argv) {
  execFileSync(bin, argv, { cwd: root, stdio: "inherit" });
}

function capture(bin, argv) {
  return execFileSync(bin, argv, { cwd: root, encoding: "utf-8" });
}
