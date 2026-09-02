/**
 * Guest / `npm run up`: ensure the roster has tokens, persist the hub→Eve
 * secret, start one `eve start` per Bot that has an Eve directory.
 */
import { dirname, join, resolve } from "node:path";
import { ensureEveSecret, ensureRosterAt } from "./ensure-roster.ts";
import { resolveEveBotsRoot } from "./eve.ts";
import { startEveProcesses } from "./start-eves.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const rosterPath = resolve(process.env.COMPUTER_DATA ?? join(repoRoot, "data/bots.json"));
const dataDir = dirname(rosterPath);
const eveSecret = ensureEveSecret(join(dataDir, "eve-secret"), process.env.COMPUTER_EVE_SECRET);
const roster = ensureRosterAt(rosterPath);
const hubPort = process.env.COMPUTER_PORT ?? "8080";
const hubUrl = process.env.COMPUTER_URL ?? `http://127.0.0.1:${hubPort}`;
const imageBots = join(repoRoot, "apps/eve/bots");
const botsRoot = resolveEveBotsRoot({
  envBots: process.env.COMPUTER_EVE_BOTS,
  imageBots,
});

startEveProcesses({
  botsRoot,
  eveSecret,
  hubUrl,
  logDir: join(dataDir, "eve-logs"),
  roster,
});
// Secret stays on the volume (`eve-secret`). Do not print it: the
// guest entrypoint reads the file so start logs cannot pollute the env.
