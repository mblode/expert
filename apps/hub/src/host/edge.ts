import { ComputerError, unavailable } from "@computer/shared";
import { flyRequest, guestState, type FlyFetch } from "./fly-machine.ts";

/**
 * Paths that must not start a suspended guest. Grok: bot.roster / bot.status
 * are cold. VNC and every other Seat/Agent call may wake.
 */
export const COLD_PATHS = new Set([
  "/healthz",
  "/cold/status",
  "/computer.v1.Seat/Status",
  "/roster",
]);

export function shouldWake(pathname: string): boolean {
  return !COLD_PATHS.has(pathname.split("?")[0] ?? pathname);
}

export type GuestMachine = {
  id: string;
  state: string;
  private_ip?: string;
  process?: string;
};

export function pickComputerMachine(machines: unknown[]): GuestMachine | undefined {
  const rows = machines as Array<{
    id?: string;
    state?: string;
    private_ip?: string;
    config?: { metadata?: Record<string, string>; env?: Record<string, string>; processes?: string[] };
  }>;
  const match = rows.find((m) => {
    const group = m.config?.metadata?.fly_process_group ?? m.config?.env?.FLY_PROCESS_GROUP;
    return group === "computer" || m.config?.env?.COMPUTER_ROLE === "guest";
  });
  const raw = match ?? (rows.length === 1 ? rows[0] : undefined);
  if (!raw?.id) return undefined;
  return {
    id: raw.id,
    state: raw.state ?? "unknown",
    private_ip: raw.private_ip,
    process: raw.config?.metadata?.fly_process_group,
  };
}

export function hibernatedBody(): unknown {
  return new ComputerError(
    "DAEMON_DOWN",
    "computer is hibernated",
    unavailable("hibernated", "attach"),
  ).toEnvelope();
}

export type EdgeDeps = {
  env?: NodeJS.ProcessEnv;
  fetch?: FlyFetch;
  now?: () => number;
  idleSuspendMs?: number;
  lastUseAt?: { t: number };
  startGuest?: (id: string) => Promise<void>;
  suspendGuest?: (id: string) => Promise<void>;
  proxy?: (guest: GuestMachine, req: { url: string; method: string }) => Promise<{ status: number; body: unknown }>;
};

/**
 * Decide whether this request may start the guest. Status/roster never do.
 */
export async function edgeDecide(
  pathname: string,
  deps: EdgeDeps = {},
): Promise<{ action: "cold" | "proxy" | "wake"; guest?: GuestMachine; guestState?: string }> {
  const listed = await flyRequest("list", { env: deps.env, fetch: deps.fetch });
  const machines = Array.isArray(listed.body) ? listed.body : [];
  const guest = pickComputerMachine(machines);
  const state = guestState(guest?.state);
  if (!shouldWake(pathname)) {
    return { action: "cold", guest, guestState: state };
  }
  if (state === "running") return { action: "proxy", guest, guestState: state };
  return { action: "wake", guest, guestState: state };
}

export function recordUse(stamp: { t: number }, now = Date.now()): void {
  stamp.t = now;
}

/** Idle suspend — minutes, never Sprites-style 30s. */
export async function maybeIdleSuspend(
  stamp: { t: number },
  deps: EdgeDeps & { guestId: string },
): Promise<boolean> {
  const idle = deps.idleSuspendMs ?? 20 * 60 * 1000;
  const now = deps.now?.() ?? Date.now();
  if (now - stamp.t < idle) return false;
  if (deps.suspendGuest) await deps.suspendGuest(deps.guestId);
  else await flyRequest("suspend", { env: { ...deps.env, FLY_MACHINE_ID: deps.guestId }, fetch: deps.fetch });
  return true;
}
