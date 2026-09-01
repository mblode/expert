/**
 * Fly Machines API — wake / sleep for the cloud computer.
 *
 * Grok: Firecracker anyrun pod, memory+disk snapshot, wake-on-connect.
 * Here: a Fly Machine. Guest may suspend when idle (minutes, not 30s).
 * The public HTTPS door is the edge process: Status/roster never start
 * the guest. VNC and other use wake it.
 *
 * Do not invent a custom Firecracker orchestrator.
 */

import { existsSync } from "node:fs";
import http from "node:http";

export const DEFAULT_FLY_API = "https://api.machines.dev";
/** Inside a Fly Machine, no API token is needed. */
export const FLY_SOCKET = "/.fly/api";

export type FlyAction = "list" | "get" | "status" | "wake" | "start" | "sleep" | "stop" | "suspend";

export type FlyConfig = {
  token: string;
  app: string;
  machine: string;
  api: string;
  socket: string;
};

export function resolveFlyConfig(env: NodeJS.ProcessEnv = process.env): FlyConfig {
  const socket =
    env.FLY_API_SOCKET ??
    (env.FLY_API_TOKEN ? "" : existsSync(env.FLY_SOCKET_PATH ?? FLY_SOCKET) ? (env.FLY_SOCKET_PATH ?? FLY_SOCKET) : "");
  return {
    token: env.FLY_API_TOKEN ?? "",
    app: env.FLY_APP_NAME ?? env.COMPUTER_FLY_APP ?? "",
    machine: env.FLY_MACHINE_ID ?? env.COMPUTER_FLY_MACHINE ?? "",
    api: socket ? "http://flaps" : (env.FLY_API_BASE ?? DEFAULT_FLY_API).replace(/\/$/, ""),
    socket,
  };
}

/** Map our verbs onto Machines API paths. `sleep` is stop. */
export function machinePath(app: string, machine: string, action: FlyAction): string {
  if (!app) throw new Error("FLY_APP_NAME is required");
  const base = `/v1/apps/${encodeURIComponent(app)}/machines`;
  if (action === "list") return base;
  if (!machine) throw new Error("FLY_MACHINE_ID is required (or list first)");
  const id = encodeURIComponent(machine);
  switch (action) {
    case "get":
    case "status":
      return `${base}/${id}`;
    case "wake":
    case "start":
      return `${base}/${id}/start`;
    case "sleep":
    case "stop":
      return `${base}/${id}/stop`;
    case "suspend":
      return `${base}/${id}/suspend`;
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

export function methodFor(action: FlyAction): "GET" | "POST" {
  return action === "list" || action === "get" || action === "status" ? "GET" : "POST";
}

/**
 * Fly machine state → the Grok-shaped words we use in docs.
 * started → running; suspended → hibernated; stopped → stopped.
 */
export function guestState(flyState: unknown): string {
  const s = String(flyState ?? "").toLowerCase();
  if (s === "started" || s === "running") return "running";
  if (s === "suspended") return "hibernated";
  if (s === "created" || s === "destroyed" || s === "stopped") return "stopped";
  if (s === "starting" || s === "stopping" || s === "suspending") return s;
  return s || "unknown";
}

export type FlyFetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export async function flyRequest(
  action: FlyAction,
  opts: { env?: NodeJS.ProcessEnv; fetch?: FlyFetch } = {},
): Promise<{ status: number; body: unknown; machine: string }> {
  const env = opts.env ?? process.env;
  const cfg = resolveFlyConfig(env);
  const fetchFn = opts.fetch ?? (cfg.socket ? unixFetch(cfg.socket) : globalThis.fetch);
  if (!cfg.token && !cfg.socket) throw new Error("FLY_API_TOKEN is required");
  if (!cfg.app) throw new Error("FLY_APP_NAME is required");

  let machine = cfg.machine;
  if (!machine && action !== "list") {
    const listed = await flyRequest("list", { ...opts, env });
    const machines = Array.isArray(listed.body) ? listed.body : [];
    const computer = machines.find((m) => {
      const meta = (m as { config?: { metadata?: Record<string, string> } }).config?.metadata;
      return meta?.fly_process_group === "computer";
    }) as { id?: string } | undefined;
    const only = (computer ?? machines[0]) as { id?: string } | undefined;
    if (only?.id && (machines.length === 1 || computer)) {
      machine = only.id;
    } else {
      throw new Error(
        machines.length === 0
          ? "no Machines in this app — fly deploy first"
          : `several Machines; set FLY_MACHINE_ID (${machines.map((m) => (m as { id?: string }).id).join(", ")})`,
      );
    }
  }

  const path = machinePath(cfg.app, machine, action);
  const res = await fetchFn(`${cfg.api}${path}`, {
    method: methodFor(action),
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "content-type": "application/json",
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : text || `HTTP ${res.status}`;
    throw new Error(`Fly API ${res.status}: ${msg}`);
  }
  return { status: res.status, body, machine };
}

function unixFetch(socketPath: string): FlyFetch {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = http.request(
        {
          socketPath,
          path: u.pathname + u.search,
          method: init?.method ?? "GET",
          headers: init?.headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              ok: (res.statusCode ?? 500) < 400,
              status: res.statusCode ?? 500,
              text: async () => text,
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
}
