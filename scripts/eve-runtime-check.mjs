/** Exercise the installed Eve runtime, with production channels and no paid model. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "expert-runtime-"));
let child;
let output = "";
let runtime = {
  revision: 1,
  instructions: "fixture-alpha",
  memory_set: true,
  memory: [],
  skills: [],
};
const hub = createServer((req, res) => {
  assert.equal(req.headers.authorization, "Bearer fixture-bot");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ runtime }));
});
await new Promise((done) => hub.listen(0, "127.0.0.1", done));
const socket = createServer();
await new Promise((done) => socket.listen(0, "127.0.0.1", done));
const { port } = socket.address();
await new Promise((done) => socket.close(done));
const env = {
  PATH: process.env.PATH,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  NODE_ENV: "production",
  PORT: String(port),
  HOST: "127.0.0.1",
  COMPUTER_URL: `http://127.0.0.1:${hub.address().port}`,
  COMPUTER_BOT_ID: "main",
  COMPUTER_BOT_TOKEN: "fixture-bot",
  COMPUTER_EVE_SECRET: "fixture-hub-secret",
  EVE_TELEMETRY_DISABLED: "1",
};
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child?.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timeout);
}
async function start() {
  child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => {
    output = (output + data).slice(-20_000);
  });
  child.stderr.on("data", (data) => {
    output = (output + data).slice(-20_000);
  });
  for (let tries = 0; tries < 100; tries += 1) {
    if (child.exitCode !== null) throw new Error("fixture server exited");
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("fixture server did not start");
}
async function send(message, acct = "one") {
  const response = await fetch(`http://127.0.0.1:${port}/eve/v1/whatsapp/message`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-computer-eve-secret": "fixture-hub-secret" },
    body: JSON.stringify({ token: "123@s.whatsapp.net", acct, surface: "dm", message }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  return payload.reply;
}
try {
  cpSync(join(root, "apps/eve/test-fixtures/runtime"), directory, { recursive: true });
  cpSync(join(root, "apps/eve/lib"), join(directory, "lib"), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "runtime-fixture",
      private: true,
      type: "module",
      dependencies: { eve: "0.49.0" },
    }),
  );
  for (const [folder, file] of [
    ["channels", "channels/whatsapp.ts"],
    ["instructions", "runtime.ts"],
  ]) {
    mkdirSync(join(directory, "agent", folder), { recursive: true });
    writeFileSync(
      join(directory, "agent", folder, "runtime.ts"),
      `export { default } from "../../lib/${file}";\n`,
    );
  }
  const executable = resolve(
    root,
    "node_modules/eve",
    JSON.parse(readFileSync(join(root, "node_modules/eve/package.json"), "utf-8")).bin.eve,
  );
  const build = spawn(process.execPath, [executable, "build"], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  build.stdout.on("data", (data) => {
    output = (output + data).slice(-20_000);
  });
  build.stderr.on("data", (data) => {
    output = (output + data).slice(-20_000);
  });
  const [exitCode] = await once(build, "exit");
  assert.equal(exitCode, 0, "Eve fixture build failed");
  await start();
  const first = await send("first-unique-message");
  assert.match(first, /fixture-alpha/);
  runtime = { ...runtime, revision: 2, instructions: "fixture-beta" };
  const second = await send("second-unique-message");
  assert.match(second, /first-unique-message/);
  assert.match(second, /second-unique-message/);
  assert.match(second, /fixture-beta/);
  assert.doesNotMatch(second, /fixture-alpha/);
  const other = await send("other-account-message", "two");
  assert.doesNotMatch(other, /first-unique-message|second-unique-message/);
  await stop();
  await start();
  const resumed = await send("after-restart-message");
  assert.match(resumed, /first-unique-message/);
  assert.match(resumed, /second-unique-message/);
  assert.match(resumed, /after-restart-message/);
  assert.match(resumed, /fixture-beta/);
  console.log(
    "Eve runtime: current turn, account isolation, configuration reload and restart continuity passed",
  );
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await stop();
  await new Promise((done) => hub.close(done));
  rmSync(directory, { recursive: true, force: true });
}
