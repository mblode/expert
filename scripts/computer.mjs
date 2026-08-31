#!/usr/bin/env node
/**
 * computer — the box in one command.
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
const envPath = resolve(root, ".env");

const [cmd, ...args] = process.argv.slice(2);

const USAGE = [
  "usage:",
  "  npm run up                 start everything, print the pairing QR",
  "  npm run qr                 reprint the pairing QR",
  "  npm run bot -- new <id>    provision a Bot (token shown once)",
  "  npm run bot -- ls [--json] list Bots",
  "  npm run bot -- rm <id>     delete a Bot",
  "  npm run bot -- token <id>  reprint a Bot's token",
].join("\n");

try {
  switch (cmd) {
    case "up":
      await up();
      break;
    case "qr":
      printPairing(loadEnv());
      break;
    case "bot":
      await bot(args);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    case "--version":
    case "-v":
      console.log(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version ?? "0.0.0");
      break;
    default:
      console.error(`unknown command: ${cmd}\n${USAGE}`);
      process.exit(1);
  }
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

async function up() {
  const env = ensureEnv();

  // 1. Desk container (skipped gracefully without Docker).
  if (has("docker")) {
    console.log("• building the desk (first run takes a few minutes)…");
    run("docker", ["compose", "up", "-d", "--build"]);
  } else {
    console.log("• docker not found — running with a fake desk (install Docker for the real thing)");
    env.COMPUTER_DESK = "fake";
  }

  // 2. Publish over Tailscale when available.
  if (has("tailscale")) {
    try {
      run("tailscale", ["serve", "--bg", `http://127.0.0.1:${env.COMPUTER_PORT}`]);
      const status = JSON.parse(exec("tailscale", ["status", "--json"]));
      const dns = status?.Self?.DNSName?.replace(/\.$/, "");
      if (dns) env.COMPUTER_PUBLIC_URL = `https://${dns}`;
      console.log(`• published via Tailscale Serve: ${env.COMPUTER_PUBLIC_URL}`);
    } catch {
      console.log("• tailscale serve failed — pairing will use the local URL; run `tailscale up` and retry");
    }
  } else {
    console.log("• tailscale not found — pairing will only work on this machine (https://tailscale.com/download)");
  }
  saveEnv(env);

  // 3. Pairing QR, then the hub in the foreground.
  printPairing(env);
  console.log("• starting the hub (ctrl-c stops it; the desk keeps running)…\n");
  const child = spawn("npx", ["tsx", "apps/hub/src/index.ts"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function bot(args) {
  const [sub, id] = args;
  const env = loadEnv();
  switch (sub) {
    case "new": {
      requireId(id);
      const token = await pairSeat(env);
      const r = await rpc(env, "/computer.v1.Seat/CreateBot", { id }, token);
      console.log(`Bot ${r.id} is live on screen ${r.display}.`);
      console.log("");
      console.log(`  token: ${r.token}`);
      console.log("");
      console.log("This token is the Bot's identity — it is shown once.");
      console.log("Give it a brain — paste into apps/eve/.env and `npm run eve`:");
      console.log("");
      console.log(`  COMPUTER_URL=http://127.0.0.1:${env.COMPUTER_PORT}`);
      console.log(`  COMPUTER_BOT_TOKEN=${r.token}`);
      break;
    }
    case "rm": {
      requireId(id);
      const token = await pairSeat(env);
      await rpc(env, "/computer.v1.Seat/DeleteBot", { id }, token);
      console.log(`Bot ${id} deleted; its screen is free.`);
      break;
    }
    case "ls": {
      const token = await pairSeat(env);
      const s = await rpc(env, "/computer.v1.Seat/Status", {}, token);
      if (args.includes("--json")) {
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
      const store = JSON.parse(readFileSync(resolve(root, env.COMPUTER_DATA ?? "data/bots.json"), "utf8"));
      const entry = store.find((b) => b.id === id);
      if (!entry) throw new Error(`no bot ${id} — run \`npm run bot -- ls\``);
      console.log(entry.token);
      break;
    }
    default:
      throw new Error("usage: npm run bot -- new|ls|rm|token [id]");
  }
}

function requireId(id) {
  if (!id) throw new Error("bot id required, e.g. `npm run bot -- new night`");
}

// --- pairing / rpc ---

async function pairSeat(env) {
  try {
    const r = await rpc(env, "/computer.v1.Seat/Pair", { code: env.COMPUTER_SETUP_CODE });
    return r.token;
  } catch (err) {
    if (/setup code/i.test(String(err?.message))) {
      throw new Error(".env's COMPUTER_SETUP_CODE does not match the running hub — restart it with `npm run up`");
    }
    throw err;
  }
}

async function rpc(env, path, body, token) {
  const base = `http://127.0.0.1:${env.COMPUTER_PORT}`;
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`hub is not running on ${base} — start it with \`npm run up\``);
  }
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
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
    if (required) throw new Error("no .env yet — run `npm run up` first");
    return {};
  }
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  if (required && !env.COMPUTER_SETUP_CODE) {
    throw new Error(".env has no COMPUTER_SETUP_CODE — run `npm run up` to generate one");
  }
  return env;
}

function saveEnv(env) {
  const lines = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
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

function run(bin, argv) {
  execFileSync(bin, argv, { cwd: root, stdio: "inherit" });
}

function exec(bin, argv) {
  return execFileSync(bin, argv, { cwd: root, encoding: "utf8" });
}
