import { createHash } from "node:crypto";
import { ComputerError, cronMatches, validCron } from "@computer/shared";
import type { ClockClient } from "./clock.ts";
import { readTokenFile, writeTokenFile } from "./provision.ts";

interface Routine {
  bot: string;
  id: string;
  revision: number;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  next_at: number;
  pending: boolean;
  failures: number;
  runs: {
    at: number;
    local: string;
    revision: number;
    state: "running" | "complete" | "failed" | "missed" | "uncertain";
  }[];
}
const minute = 60_000;
const clockId = (bot: string, id: string) =>
  createHash("sha256").update(`routine:${bot}:${id}`).digest("hex");

/** Calendar minutes, not a fixed UTC offset: DST is evaluated at each occurrence. */
export function localMinute(at: number, timezone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(at)
    .replace(" ", "T");
}
export function nextRoutine(cron: string, timezone: string, after: number): number {
  if (!validCron(cron))
    throw new ComputerError("VALIDATION", "use a supported five-field cron schedule");
  try {
    localMinute(after, timezone);
  } catch {
    throw new ComputerError("VALIDATION", "use an IANA timezone such as Australia/Melbourne");
  }
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const end = after + 366 * 24 * 60 * minute;
  for (let at = Math.floor(after / minute) * minute + minute; at <= end; at += minute) {
    const local = formatter.format(at).replace(" ", "T");
    if (cronMatches(cron, new Date(`${local}:00Z`))) return at;
  }
  throw new ComputerError("VALIDATION", "the schedule has no occurrence in the next year");
}

/** A persisted schedule and its wake publication are one lifecycle, never source files. */
export class RoutineService {
  private rows: Routine[];
  private changes: Promise<unknown> = Promise.resolve();
  private readonly running = new Set<string>();
  constructor(
    private readonly options: {
      path?: string;
      clock: ClockClient;
      run: (routine: Readonly<Routine>, key: string) => Promise<void>;
      notify: (bot: string, key: string, text: string) => Promise<void>;
      now?: () => number;
    },
  ) {
    this.rows = (options.path ? (readTokenFile(options.path, "routines") ?? []) : []) as Routine[];
    for (const row of this.rows) {
      if (
        !row ||
        typeof row.bot !== "string" ||
        typeof row.id !== "string" ||
        !Number.isInteger(row.revision) ||
        !validCron(row.cron) ||
        typeof row.prompt !== "string" ||
        !Array.isArray(row.runs) ||
        !Number.isFinite(row.next_at)
      )
        throw new Error("invalid routine store");
      localMinute(this.now(), row.timezone);
      // An interrupted external effect is never silently repeated after a restart.
      for (const run of row.runs)
        if (run.state === "running") {
          run.state = "uncertain";
          row.pending = true;
        }
    }
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private save(): void {
    if (this.options.path) writeTokenFile(this.options.path, this.rows);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.changes.then(work, work);
    this.changes = result.catch(() => undefined);
    return result;
  }
  list(bot: string) {
    return structuredClone(
      this.rows
        .filter((row) => row.bot === bot)
        .map((row) => ({
          ...row,
          next_local: row.enabled ? localMinute(row.next_at, row.timezone) : null,
        })),
    );
  }
  async configure(
    bot: string,
    input: Record<string, unknown>,
  ): Promise<ReturnType<RoutineService["list"]>> {
    return this.serial(async () => {
      if (input.operation === "list") return this.list(bot);
      if (typeof input.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(input.id))
        throw new ComputerError("VALIDATION", "a routine needs a short lowercase id");
      const old = this.rows.find((row) => row.bot === bot && row.id === input.id);
      if (input.base_revision !== (old?.revision ?? 0))
        throw new ComputerError("CONFLICT", "read the current routine revision before changing it");
      if (!["save", "pause", "resume"].includes(String(input.operation)))
        throw new ComputerError("VALIDATION", "operation must be list, save, pause or resume");
      if (!old && input.operation !== "save")
        throw new ComputerError("VALIDATION", "routine does not exist");
      const prompt = input.operation === "save" ? input.prompt : old!.prompt;
      const cron = input.operation === "save" ? input.cron : old!.cron;
      const timezone = input.operation === "save" ? input.timezone : old!.timezone;
      if (
        typeof prompt !== "string" ||
        !prompt.trim() ||
        prompt.length > 4000 ||
        typeof cron !== "string" ||
        typeof timezone !== "string"
      )
        throw new ComputerError("VALIDATION", "provide a prompt, cron and IANA timezone");
      if (!old && this.rows.filter((row) => row.bot === bot).length >= 20)
        throw new ComputerError("VALIDATION", "this assistant already has 20 routines");
      const next_at = nextRoutine(cron, timezone, this.now());
      // First make the box recoverable. A failed publication leaves a visible
      // pending schedule and this durable due wake, so the next tick retries it.
      await this.options.clock.checkAt(clockId(bot, input.id), this.now());
      const row: Routine = {
        bot,
        id: input.id,
        revision: (old?.revision ?? 0) + 1,
        prompt,
        cron,
        timezone,
        enabled: input.operation !== "pause",
        next_at,
        pending: true,
        failures: 0,
        runs: old?.runs ?? [],
      };
      this.rows = [...this.rows.filter((r) => r !== old), row];
      this.save();
      await this.publish(row).catch(() => undefined);
      return this.list(bot);
    });
  }
  private async publish(row: Routine): Promise<void> {
    await (row.enabled
      ? this.options.clock.checkAt(clockId(row.bot, row.id), row.next_at)
      : this.options.clock.hold(clockId(row.bot, row.id), 0));
    row.pending = false;
    this.save();
  }
  async tick(): Promise<void> {
    await this.serial(async () => {
      for (const row of this.rows) {
        for (const run of row.runs.filter((entry) => entry.state === "uncertain")) {
          await this.options.notify(
            row.bot,
            `routine:${row.bot}:${row.id}:${run.at}:interrupted`,
            `Routine ${row.id} was interrupted. Its outcome is uncertain; inspect the conversation before repeating it.`,
          );
          run.state = "failed";
          row.failures += 1;
          if (row.failures >= 3) row.enabled = false;
          this.save();
        }
        if (row.pending) await this.publish(row);
        if (!row.enabled || row.next_at > this.now() || this.running.has(row.bot)) continue;
        // Catch up only the newest occurrence in the last fifteen minutes.
        let at = row.next_at;
        let following = nextRoutine(row.cron, row.timezone, Math.max(at, this.now() - 15 * minute));
        while (following <= this.now()) {
          at = following;
          following = nextRoutine(row.cron, row.timezone, following);
        }
        const local = localMinute(at, row.timezone);
        row.next_at = following;
        if (this.now() - at > 15 * minute || row.runs.some((run) => run.local === local)) {
          row.runs.push({ at, local, revision: row.revision, state: "missed" });
          row.runs = row.runs.slice(-200);
          row.pending = true;
          this.save();
          await this.publish(row);
          continue;
        }
        const key = clockId(row.bot, `${row.id}:${at}`);
        await this.options.clock.hold(key);
        const run = { at, local, revision: row.revision, state: "running" as const };
        row.runs.push(run);
        row.runs = row.runs.slice(-200);
        row.pending = true;
        this.save();
        this.running.add(row.bot);
        // The revision is frozen before dispatch. Pausing stops future work,
        // not an already accepted side effect or its result delivery.
        const snapshot = structuredClone(row);
        void Promise.resolve()
          .then(() => this.options.run(snapshot, key))
          .then(
            () => this.finish(row.bot, row.id, at, true, key),
            () => this.finish(row.bot, row.id, at, false, key),
          )
          .catch(() => console.error("routine completion could not be persisted"));
        await this.publish(row);
      }
    });
  }
  private async finish(
    bot: string,
    id: string,
    at: number,
    success: boolean,
    key: string,
  ): Promise<void> {
    try {
      await this.serial(async () => {
        const row = this.rows.find((entry) => entry.bot === bot && entry.id === id)!;
        const run = row.runs.find((entry) => entry.at === at)!;
        run.state = success ? "complete" : "failed";
        row.failures = success ? 0 : row.failures + 1;
        if (row.failures >= 3) {
          row.enabled = false;
          row.pending = true;
        }
        this.save();
        if (!success)
          await this.options.notify(
            bot,
            `routine:${bot}:${id}:${at}:failed`,
            `Routine ${id} could not finish.${row.enabled ? "" : " It is paused after three failures."}`,
          );
        if (row.pending) await this.publish(row);
        await this.options.clock.hold(key, 0);
      });
    } finally {
      this.running.delete(bot);
    }
  }
}
