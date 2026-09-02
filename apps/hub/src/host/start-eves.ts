/**
 * Start one `eve start` per roster Bot that has an Eve project under
 * COMPUTER_EVE_BOTS (or a volume overlay). Bind loopback only. Tokens
 * and the hub→Eve secret stay on the volume.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { planEveLaunches } from "./eve.ts";
import type { EveLaunch } from "./eve.ts";
import type { BotConfig } from "../service/bots.ts";

interface StartEvesOpts {
  roster: readonly BotConfig[];
  botsRoot: string;
  hubUrl: string;
  eveSecret: string;
  logDir: string;
  basePort?: number;
  env?: NodeJS.ProcessEnv;
}

export function eveChildEnv(
  launch: EveLaunch,
  opts: { hubUrl: string; eveSecret: string; env?: NodeJS.ProcessEnv },
): NodeJS.ProcessEnv {
  return {
    ...opts.env,
    COMPUTER_BOT_TOKEN: launch.token,
    COMPUTER_EVE_SECRET: opts.eveSecret,
    COMPUTER_URL: opts.hubUrl,
    HOST: "127.0.0.1",
    PORT: String(launch.port),
  };
}

export function startEveProcesses(opts: StartEvesOpts): ChildProcess[] {
  const launches = planEveLaunches(opts.roster, {
    basePort: opts.basePort,
    botsRoot: opts.botsRoot,
  });
  mkdirSync(opts.logDir, { mode: 0o700, recursive: true });
  const children: ChildProcess[] = [];
  for (const launch of launches) {
    const log = resolve(opts.logDir, `eve-${launch.botId}.log`);
    mkdirSync(dirname(log), { recursive: true });
    const out = openSync(log, "a");
    const child = spawn(
      "npx",
      ["eve", "start", "--host", "127.0.0.1", "--port", String(launch.port)],
      {
        cwd: launch.cwd,
        detached: true,
        env: eveChildEnv(launch, {
          hubUrl: opts.hubUrl,
          eveSecret: opts.eveSecret,
          env: opts.env ?? process.env,
        }),
        stdio: ["ignore", out, out],
      },
    );
    child.unref();
    children.push(child);
    console.log(`computer eve: bot ${launch.botId} on 127.0.0.1:${launch.port} (log ${log})`);
  }
  return children;
}
