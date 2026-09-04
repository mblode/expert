/**
 * `npm run up`: supervise one `eve start` per roster Bot on a dev machine.
 *
 * On the guest, PID 1 (`init.ts`) supervises the Eves next to the desk, the
 * bridge and the hub. Locally the desk is docker compose and the hub runs in
 * the foreground under `scripts/computer.mjs`, so the Eves are all there is
 * to supervise, but they go through the same `superviseEves` and the same
 * `Supervisor`: a dev debugging an Eve gets its restarts, its health probe
 * and its environment, not the detached spawn this replaced.
 *
 * The roster, its tokens and the hub→Eve secret land beside `COMPUTER_DATA`,
 * where the hub reads them. The secret stays on disk and is never printed.
 */
import { dirname, join, resolve } from "node:path";
import { ensureEveSecret, ensureRosterAt } from "./ensure-roster.ts";
import { eveProjectIds, planEveLaunches, resolveEveBotsRoot, superviseEves } from "./eve.ts";
import { Supervisor } from "./supervisor.ts";

// Four segments up from apps/hub/src/host, not three: `../../..` is `apps/`,
// so `imageBots` resolved to <root>/apps/apps/eve/bots, no roster Bot had a
// project there, and the local path this replaces started zero Eves without
// saying so. The guest never noticed because fly.toml sets COMPUTER_EVE_BOTS.
// `init.ts` counts four now too, and checks it rather than trusting it.
const repoRoot = resolve(import.meta.dirname, "../../../..");
const { env } = process;

const rosterPath = resolve(env.COMPUTER_DATA ?? join(repoRoot, "data/bots.json"));
const dataDir = dirname(rosterPath);
const hubPort = env.COMPUTER_PORT ?? "8080";
const hubUrl = env.COMPUTER_URL ?? `http://127.0.0.1:${hubPort}`;
const logDir = env.COMPUTER_LOG_DIR ?? join(dataDir, "logs");
const eveSecret = ensureEveSecret(join(dataDir, "eve-secret"), env.COMPUTER_EVE_SECRET);
const botsRoot = resolveEveBotsRoot({
  envBots: env.COMPUTER_EVE_BOTS,
  imageBots: join(repoRoot, "apps/eve/bots"),
});

// The roster gains a row for every project this tree ships, so `npm run up`
// brings up the same Bots the guest does rather than only the ones a dev
// happened to create by hand.
const launches = planEveLaunches(ensureRosterAt(rosterPath, eveProjectIds(botsRoot)), {
  botsRoot,
});
// No status file unless the caller asked for one: `/healthz` reads whatever
// file it is pointed at and calls a file nobody refreshes stale, so only a
// run that owns this supervisor should wire the hub to it.
const sup = new Supervisor({
  onEvent: (line) => console.log(`computer ${line}`),
  statusFile: env.COMPUTER_STATUS_FILE,
});
superviseEves(sup, launches, { env, eveSecret, hubUrl, logDir });

if (launches.length === 0) {
  console.warn(`computer eve: no Eve project under ${botsRoot}; chat will report DAEMON_DOWN`);
} else {
  for (const launch of launches) {
    console.log(
      `computer eve: bot ${launch.botId} on 127.0.0.1:${launch.port} (log ${join(logDir, `eve-${launch.botId}.log`)})`,
    );
  }
}

const shutdown = (): void => {
  void sup.stopAll().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
