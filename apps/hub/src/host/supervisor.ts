import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The process supervisor for one computer.
 *
 * The guest used to spawn its Eve children detached and forget them: a dead
 * Eve was `DAEMON_DOWN` until the Machine restarted, and `/healthz` said ok
 * regardless (AUDIT P1 #5). This keeps every child (Eve per Bot, the
 * WhatsApp bridge, the desk) attached, restarts it with backoff, probes its
 * health URL, and writes one status file the hub's `/healthz` reads. It is
 * also the seam the Phase 3 self-rebuild uses: a deploy is "build, then ask
 * the supervisor to restart this child".
 *
 * Deliberately small. Not systemd: a handful of children on one box, and
 * the policy for each is the same three numbers.
 */
export interface ChildSpec {
  id: string;
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Run as this user. Only honoured when the supervisor is root. */
  uid?: number;
  gid?: number;
  /** Appended to; the child's stdout and stderr. */
  log: string;
  /** Probed after start and every `healthEveryMs`; 2xx is healthy. */
  healthUrl?: string;
  /** A one-shot child (desk-up) exits 0 and stays "done" rather than restarting. */
  oneShot?: boolean;
}

export type ChildState = "starting" | "up" | "down" | "restarting" | "done" | "stopped";

export interface ChildStatus {
  id: string;
  state: ChildState;
  pid: number | null;
  healthy: boolean | null;
  restarts: number;
  last_exit: { code: number | null; signal: string | null; at: string } | null;
  since: string;
}

export interface SupervisorStatus {
  ok: boolean;
  at: string;
  children: ChildStatus[];
}

export interface SupervisorOptions {
  /** Where `status()` is mirrored so another process (the hub) can read it. */
  statusFile?: string;
  /** Log rotation: a log over this size is moved aside once at (re)start. */
  maxLogBytes?: number;
  healthEveryMs?: number;
  healthTimeoutMs?: number;
  backoff?: { initialMs: number; maxMs: number; stableMs: number };
  fetchImpl?: typeof fetch;
  onEvent?: (line: string) => void;
}

interface Managed {
  spec: ChildSpec;
  child: ChildProcess | null;
  state: ChildState;
  healthy: boolean | null;
  restarts: number;
  lastExit: ChildStatus["last_exit"];
  since: number;
  startedAt: number;
  backoffMs: number;
  restartTimer: NodeJS.Timeout | null;
  healthTimer: NodeJS.Timeout | null;
  wantRunning: boolean;
}

const DEFAULT_BACKOFF = { initialMs: 1000, maxMs: 30_000, stableMs: 60_000 };

export class Supervisor {
  private readonly children = new Map<string, Managed>();
  private readonly opts: Required<Omit<SupervisorOptions, "statusFile" | "onEvent">> &
    Pick<SupervisorOptions, "statusFile" | "onEvent">;
  private stopping = false;

  constructor(opts: SupervisorOptions = {}) {
    this.opts = {
      backoff: opts.backoff ?? DEFAULT_BACKOFF,
      fetchImpl: opts.fetchImpl ?? fetch,
      healthEveryMs: opts.healthEveryMs ?? 15_000,
      healthTimeoutMs: opts.healthTimeoutMs ?? 5000,
      maxLogBytes: opts.maxLogBytes ?? 20 * 1024 * 1024,
      onEvent: opts.onEvent,
      statusFile: opts.statusFile,
    };
  }

  /** Register and start a child. Starting twice is a no-op. */
  start(spec: ChildSpec): void {
    if (this.children.has(spec.id)) {
      return;
    }
    const m: Managed = {
      backoffMs: this.opts.backoff.initialMs,
      child: null,
      healthTimer: null,
      healthy: null,
      lastExit: null,
      restartTimer: null,
      restarts: 0,
      since: Date.now(),
      spec,
      startedAt: 0,
      state: "starting",
      wantRunning: true,
    };
    this.children.set(spec.id, m);
    this.launch(m);
  }

  /** Stop one child (SIGTERM, then SIGKILL after `graceMs`) and keep it stopped. */
  async stop(id: string, graceMs = 10_000): Promise<void> {
    const m = this.children.get(id);
    if (!m) {
      return;
    }
    m.wantRunning = false;
    this.clearTimers(m);
    await this.kill(m, graceMs);
    this.setState(m, "stopped");
  }

  /** Stop, then start again with the same spec: the deploy path's last step. */
  async restart(id: string, graceMs = 10_000): Promise<void> {
    const m = this.children.get(id);
    if (!m) {
      return;
    }
    await this.stop(id, graceMs);
    m.wantRunning = true;
    m.backoffMs = this.opts.backoff.initialMs;
    this.launch(m);
  }

  /** Stop everything, longest-running first is not needed: they are independent. */
  async stopAll(graceMs = 10_000): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.children.keys()].map((id) => this.stop(id, graceMs)));
  }

  status(now = Date.now()): SupervisorStatus {
    const children = [...this.children.values()].map((m) => ({
      healthy: m.healthy,
      id: m.spec.id,
      last_exit: m.lastExit,
      pid: m.child?.pid ?? null,
      restarts: m.restarts,
      since: new Date(m.since).toISOString(),
      state: m.state,
    }));
    // "ok" is every long-running child up and, where it has a probe, healthy.
    const ok = children.every(
      (c) => c.state === "done" || (c.state === "up" && c.healthy !== false),
    );
    return { at: new Date(now).toISOString(), children, ok };
  }

  private launch(m: Managed): void {
    if (this.stopping || !m.wantRunning) {
      return;
    }
    rotateLog(m.spec.log, this.opts.maxLogBytes);
    mkdirSync(dirname(m.spec.log), { mode: 0o700, recursive: true });
    const out = openSync(m.spec.log, "a");
    let child: ChildProcess;
    try {
      child = spawn(m.spec.cmd, m.spec.args, {
        cwd: m.spec.cwd,
        env: m.spec.env,
        gid: m.spec.gid,
        stdio: ["ignore", out, out],
        uid: m.spec.uid,
      });
    } catch (error) {
      // spawn itself can throw (a bad uid without root). Treat as an exit.
      this.log(`${m.spec.id}: spawn failed: ${(error as Error).message}`);
      this.onExit(m, null, null);
      return;
    } finally {
      // The child holds its own copy of the descriptor; keeping ours would
      // leak one per restart, and PID 1 restarts for the life of the box.
      closeSync(out);
    }
    m.child = child;
    m.startedAt = Date.now();
    m.since = m.startedAt;
    m.healthy = null;
    this.setState(m, "starting");
    this.log(`${m.spec.id}: started pid ${child.pid ?? "?"}`);
    // Only the first of "error" and "exit" counts: a spawn failure (ENOENT,
    // EACCES, EMFILE) arrives as "error" with no pid and may never "exit", and
    // without this a missing binary sat "up" forever with nothing running.
    const done = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (m.child === child) {
        this.onExit(m, code, signal);
      }
    };
    child.on("error", (error) => {
      this.log(`${m.spec.id}: ${error.message}`);
      if (child.pid === undefined) {
        done(null, null);
      }
    });
    child.on("exit", done);
    if (m.spec.healthUrl) {
      this.scheduleHealth(m, 500);
    } else if (!m.spec.oneShot) {
      // No probe: the process being alive is the whole signal.
      this.setState(m, "up");
    }
  }

  private onExit(m: Managed, code: number | null, signal: NodeJS.Signals | null): void {
    this.clearTimers(m);
    m.child = null;
    m.lastExit = { at: new Date().toISOString(), code, signal };
    if (m.spec.oneShot && code === 0) {
      this.setState(m, "done");
      this.log(`${m.spec.id}: finished`);
      return;
    }
    if (!m.wantRunning || this.stopping) {
      this.setState(m, "stopped");
      return;
    }
    // A child that stayed up long enough gets a fresh backoff; a crash loop
    // grows it to the cap so a broken build does not spin the box.
    const upFor = Date.now() - m.startedAt;
    if (upFor >= this.opts.backoff.stableMs) {
      m.backoffMs = this.opts.backoff.initialMs;
    }
    const delay = m.backoffMs;
    m.backoffMs = Math.min(m.backoffMs * 2, this.opts.backoff.maxMs);
    m.restarts += 1;
    this.setState(m, "restarting");
    this.log(
      `${m.spec.id}: exited (code ${code ?? "null"}, signal ${signal ?? "none"}), restart in ${delay}ms`,
    );
    // Deliberately ref'd: a pending restart is the only thing this process
    // still owes, and an unref'd timer let the loop empty and the supervisor
    // exit mid-backoff. `npm run up` is where that showed: the Eve supervisor
    // holds nothing else, so one crash ended supervision without a word.
    m.restartTimer = setTimeout(() => {
      m.restartTimer = null;
      this.launch(m);
    }, delay);
  }

  private scheduleHealth(m: Managed, inMs: number): void {
    m.healthTimer = setTimeout(() => {
      m.healthTimer = null;
      void this.probe(m);
    }, inMs);
    m.healthTimer.unref?.();
  }

  private async probe(m: Managed): Promise<void> {
    if (!m.child || !m.spec.healthUrl) {
      return;
    }
    let healthy = false;
    try {
      const res = await this.opts.fetchImpl(m.spec.healthUrl, {
        signal: AbortSignal.timeout(this.opts.healthTimeoutMs),
      });
      healthy = res.ok;
    } catch {
      healthy = false;
    }
    if (!m.child) {
      return;
    }
    const was = m.healthy;
    m.healthy = healthy;
    if (healthy) {
      this.setState(m, "up");
      if (was === false) {
        this.log(`${m.spec.id}: healthy again`);
      }
    } else if (m.state === "up") {
      this.log(`${m.spec.id}: health probe failed`);
    }
    // While starting, probe fast so a slow boot is not reported down for 15 s.
    this.scheduleHealth(
      m,
      healthy ? this.opts.healthEveryMs : Math.min(1000, this.opts.healthEveryMs),
    );
  }

  private kill(m: Managed, graceMs: number): Promise<void> {
    const { child } = m;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const hard = setTimeout(() => child.kill("SIGKILL"), graceMs);
      hard.unref?.();
      child.once("exit", () => {
        clearTimeout(hard);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private clearTimers(m: Managed): void {
    if (m.restartTimer) {
      clearTimeout(m.restartTimer);
      m.restartTimer = null;
    }
    if (m.healthTimer) {
      clearTimeout(m.healthTimer);
      m.healthTimer = null;
    }
  }

  private setState(m: Managed, state: ChildState): void {
    if (m.state !== state) {
      m.state = state;
      m.since = Date.now();
    }
    this.writeStatus();
  }

  private writeStatus(): void {
    const file = this.opts.statusFile;
    if (!file) {
      return;
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.status(), null, 2)}\n`, { mode: 0o644 });
      renameSync(tmp, file);
    } catch (error) {
      this.log(`status file: ${(error as Error).message}`);
    }
  }

  private log(line: string): void {
    this.opts.onEvent?.(`supervisor ${line}`);
  }
}

/** Move a log aside once it is large; the child keeps writing to a fresh file. */
function rotateLog(path: string, maxBytes: number): void {
  try {
    if (statSync(path).size > maxBytes) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    // Missing log, or a race with the previous rotation: nothing to move.
  }
}
