import { readFileSync } from "node:fs";

/** One supervised child as the supervisor's status file reports it. */
export interface HealthChild {
  id: string;
  state: string;
  healthy: boolean | null;
  restarts: number;
}

export interface HealthReport {
  ok: boolean;
  hub: true;
  /** Absent when no supervisor status is available (local dev, tests). */
  supervisor?: {
    at: string;
    stale: boolean;
    children: HealthChild[];
  };
}

/** A status file older than this is a supervisor that stopped writing, which is its own kind of down. */
const STALE_MS = 2 * 60_000;

/** Unreadable, unparseable, or not the shape a supervisor writes: all one answer. */
const UNREADABLE: HealthReport = {
  hub: true,
  ok: false,
  supervisor: { at: "", children: [], stale: true },
};

/**
 * `/healthz` used to be `{ ok: true }` unconditionally, so a Machine with no
 * X server and no Eve was healthy (AUDIT P1 #5). The supervisor mirrors its
 * view into a file; this reads it. The hub answering at all is the `hub`
 * field; `ok` is the whole computer.
 *
 * Every bad file has to land on `UNREADABLE` rather than throw. `fly.toml`
 * health-checks the guest on this route, and a throw here is a 500, which is
 * a failed check and a restarted Machine: the opposite of the "always answer,
 * report the detail in `ok`" rule this route exists for.
 */
export function readHealth(statusFile: string | undefined, now = Date.now()): HealthReport {
  if (!statusFile) {
    return { hub: true, ok: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statusFile, "utf-8"));
  } catch {
    return UNREADABLE;
  }
  // `JSON.parse("null")` and a bare number both parse, and reading `.at` off
  // either throws. Everything below treats the file as untrusted anyway.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return UNREADABLE;
  }
  const record = parsed as { ok?: unknown; at?: unknown; children?: unknown };
  const at = typeof record.at === "string" ? record.at : "";
  const written = Date.parse(at);
  // An unparseable timestamp is stale, not fresh: `NaN > STALE_MS` is false,
  // so comparing without this check read a garbage `at` as "written just now"
  // and let a stopped supervisor keep reporting ok.
  const stale = !Number.isFinite(written) || now - written > STALE_MS;
  const children = Array.isArray(record.children)
    ? record.children.map((entry): HealthChild => {
        const c = (entry ?? {}) as Record<string, unknown>;
        return {
          healthy: typeof c.healthy === "boolean" ? c.healthy : null,
          id: String(c.id),
          restarts: Number(c.restarts ?? 0),
          state: String(c.state),
        };
      })
    : [];
  return { hub: true, ok: Boolean(record.ok) && !stale, supervisor: { at, children, stale } };
}
