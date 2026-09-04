import { createServer } from "node:http";
import { resolve } from "node:path";
import { dueSoon, nextDue, readSchedule } from "./schedule.ts";
import { parseTargets, Tenant } from "./tenant.ts";

/**
 * The clock outside the box.
 *
 * A computer suspends to zero when nobody is using it, which is the whole
 * economics of the thing: eight Bots on a 2 GB Machine that bills nothing
 * overnight. A suspended Machine has no clock. Every in-guest answer to that
 * is circular (croner, supercronic, the hub's own alarm: all of them stopped),
 * and Fly's scheduled Machines are documented as fuzzy interval buckets timed
 * from machine creation, which is not a thing to hang a 06:00 brief on. Fly's
 * own guidance for anything that has to happen at a time is a separate,
 * always-on app that pokes the app that sleeps, and this is that app.
 *
 * It is as small as the job allows: no credential, no database, no state that
 * outlives the process. It reads the Bots' routine manifests out of its own
 * image, and a few minutes before any routine minute it GETs the tenant's
 * public `/healthz`, which Fly Proxy serves by starting the Machine. From
 * there the box's own alarm (`apps/hub/src/host/routines.ts`) wakes the Bot
 * and the Bot's croner fires the routine, exactly as it does for a box that
 * happened to be awake. The clock never runs a routine and cannot: it does
 * not know what one is.
 *
 * It costs about $2 a month, against $10 or more for the 2 GB guest simply
 * never suspending, which was the only other honest fix.
 *
 * What it still does not do, and cannot: catch up. A routine whose minute
 * passes while this app is down (a deploy, a crash, a host it did not come
 * back on) is missed, exactly as before. Firing one late would mean telling a
 * Bot to run it, which needs a credential and a route into the box, and this
 * app deliberately holds neither. The failure is rarer, not gone.
 */

/** Seconds in the environment, milliseconds in the code. */
function ms(name: string, fallbackSec: number): number {
  const raw = Number(process.env[name]);
  return (Number.isFinite(raw) && raw > 0 ? raw : fallbackSec) * 1000;
}

// How far ahead of a routine's minute the Machine is woken. It has to cover a
// resume from suspend, the hub coming back to the wake directory, and the
// sleeping Bot's Eve starting: seconds, each of them, but the failure of
// being late is a routine that does not run, so the lead is minutes.
const leadMs = ms("CLOCK_LEAD_SEC", 180);
const holdMs = ms("CLOCK_HOLD_SEC", 600);
const busyGraceMs = ms("CLOCK_BUSY_GRACE_SEC", 300);
const maxHoldMs = ms("CLOCK_MAX_HOLD_SEC", 3600);
const tickMs = ms("CLOCK_TICK_SEC", 30);
const timeoutMs = ms("CLOCK_TIMEOUT_SEC", 30);

// The same tree the guest image ships, so a routine is declared once, in the
// Bot's own directory, and both alarms read that.
const botsRoot = process.env.CLOCK_BOTS ?? resolve(import.meta.dirname, "../../eve/bots");
const schedule = readSchedule(botsRoot, (line) => {
  console.warn(line);
});
const routineCount = schedule.reduce((n, bot) => n + bot.routines.length, 0);

const log = (line: string): void => {
  console.log(`clock ${line}`);
};

const tenants = parseTargets(process.env.CLOCK_TARGETS, (line) => {
  console.warn(line);
}).map(
  (t) =>
    new Tenant({
      busyGraceMs,
      holdMs,
      log,
      maxHoldMs,
      name: t.name,
      timeoutMs,
      url: t.url,
    }),
);

log(`bots ${botsRoot}: ${schedule.length} Bots, ${routineCount} routines`);
log(`targets ${tenants.map((t) => `${t.name} ${t.url}`).join(", ") || "(none)"}`);
for (const due of nextDue(schedule, Date.now())) {
  log(`next ${due.botId}/${due.routineId} at ${new Date(due.atMs).toISOString()}`);
}
if (routineCount === 0 || tenants.length === 0) {
  // Not fatal on purpose: exiting would restart-loop the Machine and lose the
  // logs above, which are what say why. `/healthz` fails instead, which is
  // what the platform check reads, and a person sees both.
  console.warn(
    "clock: nothing to do (no routines, or no CLOCK_TARGETS); /healthz will report not ok",
  );
}

const tick = (): void => {
  const at = Date.now();
  const due = dueSoon(schedule, at, leadMs);
  for (const tenant of tenants) {
    if (due.length > 0) {
      tenant.wake(
        due.map((d) => `${d.botId}/${d.routineId} at ${new Date(d.atMs).toISOString()}`).join(", "),
      );
    }
    // Fire and forget: a slow resume must not delay the other tenants, and
    // `poll` refuses to overlap itself and never rejects.
    void tenant.poll();
  }
};
tick();
const timer = setInterval(tick, tickMs);

// The clock is not a service: it publishes no port to the internet and the
// only thing that talks to it is the Machine check in `fly.clock.toml`.
// It answers not ok when it has no schedule or no targets, because a clock
// that is up and doing nothing is the exact failure this app exists to stop
// being invisible.
const server = createServer((req, res) => {
  const now = Date.now();
  const ok = routineCount > 0 && tenants.length > 0;
  const body = JSON.stringify(
    {
      at: new Date(now).toISOString(),
      bots_root: botsRoot,
      hold: {
        busy_grace_sec: busyGraceMs / 1000,
        lead_sec: leadMs / 1000,
        max_sec: maxHoldMs / 1000,
        sec: holdMs / 1000,
      },
      next: nextDue(schedule, now)
        .slice(0, 10)
        .map((d) => ({ at: new Date(d.atMs).toISOString(), bot: d.botId, routine: d.routineId })),
      ok,
      routines: routineCount,
      targets: tenants.map((t) => t.status()),
    },
    null,
    2,
  );
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  res.end(req.method === "HEAD" ? undefined : body);
});
const port = Number(process.env.CLOCK_PORT ?? 8080);
const bind = process.env.CLOCK_BIND ?? "0.0.0.0";
server.listen(port, bind, () => {
  log(`on http://${bind}:${port}`);
});

const shutdown = (): void => {
  clearInterval(timer);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
