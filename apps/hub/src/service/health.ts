import { readFileSync } from "node:fs";

export interface HealthReport {
  ok: boolean;
  hub: true;
  /** Absent when no supervisor status is available (local dev, tests). */
  supervisor?: {
    at: string;
    stale: boolean;
    children: { id: string; state: string; healthy: boolean | null; restarts: number }[];
  };
}

/** A status file older than this is a supervisor that stopped writing, which is its own kind of down. */
const STALE_MS = 2 * 60_000;

/**
 * `/healthz` used to be `{ ok: true }` unconditionally, so a Machine with no
 * X server and no Eve was healthy (AUDIT P1 #5). The supervisor mirrors its
 * view into a file; this reads it. The hub answering at all is the `hub`
 * field; `ok` is the whole computer.
 */
export function readHealth(statusFile: string | undefined, now = Date.now()): HealthReport {
  if (!statusFile) {
    return { hub: true, ok: true };
  }
  let parsed: {
    ok?: boolean;
    at?: string;
    children?: HealthReport["supervisor"] extends infer S
      ? S extends { children: infer C }
        ? C
        : never
      : never;
  };
  try {
    parsed = JSON.parse(readFileSync(statusFile, "utf-8"));
  } catch {
    return { hub: true, ok: false, supervisor: { at: "", children: [], stale: true } };
  }
  const at = typeof parsed.at === "string" ? parsed.at : "";
  const stale = !at || now - Date.parse(at) > STALE_MS;
  const children = Array.isArray(parsed.children)
    ? parsed.children.map((c) => ({
        healthy: c.healthy ?? null,
        id: String(c.id),
        restarts: Number(c.restarts ?? 0),
        state: String(c.state),
      }))
    : [];
  return { hub: true, ok: Boolean(parsed.ok) && !stale, supervisor: { at, children, stale } };
}
