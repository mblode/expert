/**
 * Create and destroy a tenant computer through the Fly Machines API.
 *
 * `fly-machine.ts` covers the verbs an existing guest needs (wake, suspend,
 * stop). This is the other half: a tenant that can be created rather than
 * declared. `fly deploy` is a client of the same API, so nothing here is a
 * private path; what it replaces is a human writing `fly.<tenant>.toml`,
 * running `fly apps create`, `fly volumes create` and `fly deploy`, then
 * adding the tenant to the control plane's catalog by hand.
 *
 * The shape is app-per-tenant, matching `fly.toml` and `fly.vcmc.toml`. One
 * app, one volume, one Machine, one hostname. Machine-per-tenant inside a
 * shared app would be cheaper to manage and is the wrong trade here: Fly's
 * secret store is per app, and this design leans on that (`init.ts` refuses to
 * mint a setup code on a cloud deployment precisely because the platform is
 * meant to hand it one), so a shared app would put every tenant's setup code
 * in one namespace. An app is also the unit a `fly.dev` hostname and a delete
 * come in.
 *
 * This module deliberately does NOT set secrets. Fly delivers app secrets to
 * the guest as environment variables, so an unwary caller could pass
 * `COMPUTER_SETUP_CODE` in `env` here and the guest would boot happily: the
 * difference is that a Machine's `config.env` reads back out of
 * `GET /machines/<id>`, and a secret does not. `assertNoSecrets` refuses that
 * rather than leaving it to reviewer memory. Set the tenant's secrets on the
 * app first (`fly secrets set`, or the platform's GraphQL `setSecrets`), then
 * create the Machine, which is also the order that gets them into the first
 * boot rather than the second.
 *
 * Still not a custom Firecracker orchestrator; see the note in
 * `fly-machine.ts`. This asks Fly for a Machine, it does not run one.
 */

import { appsPath, flyCall, machinePath, volumesPath } from "./fly-machine.ts";
import type { FlyConfig, FlyFetch } from "./fly-machine.ts";

/** Where a created guest mounts its volume. Matches `fly.toml` and the Dockerfile. */
export const WORKSPACE_PATH = "/workspace";
/** The volume name every tenant uses; it is scoped by app, so it need not be unique. */
export const WORKSPACE_VOLUME = "computer_workspace";
/**
 * The process group `fly-machine.ts` looks for when an app has several
 * Machines and no `FLY_MACHINE_ID`. A created Machine that omits it is a
 * Machine the wake path cannot find.
 */
export const PROCESS_GROUP = "computer";

/**
 * Env keys that must never reach `config.env`, because each one is a
 * credential that would then be readable from the Machines API.
 *
 * The same three `init.ts` strips from every child environment, for the same
 * reason in a different direction: there so the model cannot read them, here
 * so anyone holding a Fly token cannot.
 */
const SECRET_ENV = new Set(["COMPUTER_SETUP_CODE", "WHATSAPP_BRIDGE_SECRET", "FLY_API_TOKEN"]);

/** What a tenant computer is, in the terms the API takes. */
export interface ComputerSpec {
  /** Fly app name, and so the tenant's hostname: `<app>.fly.dev`. */
  app: string;
  /** Fly organisation slug the app is created under. */
  org: string;
  /** Region for both the volume and the Machine. They must agree: volumes do not move. */
  region: string;
  /** Guest image reference, the one `deploy/fly/Dockerfile` produced. */
  image: string;
  /** Non-secret guest configuration. Secrets go on the app, never here. */
  env?: Record<string, string>;
  /** Volume size. `/workspace` holds the desk files, the roster and Eve's build. */
  volumeSizeGb?: number;
  cpus?: number;
  memoryMb?: number;
  /**
   * `suspend` keeps the memory snapshot and wakes in well under a second;
   * `off` is what a tenant holding a WhatsApp socket needs, because the socket
   * cannot survive a suspend. Anything else is a tenant that pays for idle.
   */
  autostop?: "suspend" | "stop" | "off";
}

interface CallOpts {
  cfg?: FlyConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: FlyFetch;
}

/** Refuse an env that carries a credential. Throws naming the key, so the fix is obvious. */
export function assertNoSecrets(env: Record<string, string> | undefined): void {
  for (const key of Object.keys(env ?? {})) {
    if (SECRET_ENV.has(key)) {
      throw new Error(
        `${key} must be set as a Fly app secret, not in the Machine config: config.env reads back from the Machines API`,
      );
    }
  }
}

/**
 * The Machine config for a tenant guest, as a pure function so the shape is
 * testable without a Fly account.
 *
 * It mirrors `fly.toml`, and the fields that are load-bearing rather than
 * cosmetic are: the `metadata.fly_process_group`, without which the wake path
 * cannot find this Machine; `autostart`, which is what lets an inbound request
 * resume a suspended tenant (Fly Proxy holds the connection while it comes
 * back, and only the proxy does this: a request over the private network
 * reaches a suspended guest as a connection error); the `/healthz` check,
 * which reports the supervisor's view of every child; and the mount, because a
 * guest with no `/workspace` mints a fresh roster on a volume that vanishes.
 */
export function machineConfig(spec: ComputerSpec, volumeId: string): Record<string, unknown> {
  assertNoSecrets(spec.env);
  return {
    auto_destroy: false,
    checks: {
      healthz: {
        grace_period: "40s",
        interval: "30s",
        method: "GET",
        path: "/healthz",
        port: 8080,
        timeout: "5s",
        type: "http",
      },
    },
    env: {
      COMPUTER_BIND: "0.0.0.0",
      COMPUTER_CLOUD: "fly",
      COMPUTER_PORT: "8080",
      ...spec.env,
    },
    guest: {
      cpu_kind: "shared",
      // Chromium, Xvfb, Eve and the hub do not fit in 1 GB, and one vCPU
      // stutters VNC while Eve drives the desk. 2 GB is also Fly's ceiling for
      // a suspendable Machine, so a bigger guest trades wake for headroom.
      cpus: spec.cpus ?? 2,
      memory_mb: spec.memoryMb ?? 2048,
    },
    image: spec.image,
    metadata: { fly_process_group: PROCESS_GROUP },
    mounts: [{ path: WORKSPACE_PATH, volume: volumeId }],
    restart: { policy: "always" },
    services: [
      {
        autostart: true,
        autostop: spec.autostop ?? "suspend",
        concurrency: { hard_limit: 40, soft_limit: 20, type: "requests" },
        internal_port: 8080,
        min_machines_running: 0,
        ports: [
          { handlers: ["http"], force_https: true, port: 80 },
          { handlers: ["http", "tls"], port: 443 },
        ],
        protocol: "tcp",
      },
    ],
  };
}

/** What a successful create leaves behind, and what a destroy needs. */
export interface CreatedComputer {
  app: string;
  machineId: string;
  volumeId: string;
  hubUrl: string;
}

/**
 * Create the app, its volume and its Machine, in that order.
 *
 * Not transactional, and it cannot be: Fly has no such thing. A failure part
 * way leaves the app (and possibly the volume) behind, which is why the error
 * says which step failed and `destroyComputer` is safe to call on a partial
 * one. The alternative, unwinding here, would delete a volume on a transient
 * API error and take the tenant's data with it.
 */
export async function createComputer(
  spec: ComputerSpec,
  opts: CallOpts = {},
): Promise<CreatedComputer> {
  assertNoSecrets(spec.env);
  await flyCall(appsPath(), "POST", {
    ...opts,
    payload: { app_name: spec.app, org_slug: spec.org },
  });

  const volume = await flyCall(volumesPath(spec.app), "POST", {
    ...opts,
    payload: {
      name: WORKSPACE_VOLUME,
      region: spec.region,
      size_gb: spec.volumeSizeGb ?? 10,
    },
  });
  const volumeId = idOf(volume.body);
  if (!volumeId) {
    throw new Error(`Fly created no volume for ${spec.app}`);
  }

  const machine = await flyCall(machinePath(spec.app, "", "create"), "POST", {
    ...opts,
    payload: {
      config: machineConfig(spec, volumeId),
      region: spec.region,
    },
  });
  const machineId = idOf(machine.body);
  if (!machineId) {
    throw new Error(`Fly created no Machine for ${spec.app}`);
  }

  return { app: spec.app, hubUrl: `https://${spec.app}.fly.dev`, machineId, volumeId };
}

/**
 * Delete the app, which takes its Machines and volumes with it.
 *
 * One call rather than three because a per-resource teardown can strand an app
 * with a volume nobody bills anyone for, and because it is the only step that
 * is idempotent enough to retry: an app that is already gone answers 404,
 * which `missing` reads as done.
 */
export async function destroyComputer(app: string, opts: CallOpts = {}): Promise<void> {
  try {
    await flyCall(appsPath(app), "DELETE", opts);
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
  }
}

/** Fly answers a create with the created object; take its id. */
function idOf(body: unknown): string {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : "";
}

/** A 404 from `flyCall`, which formats its errors as `Fly API <status>: …`. */
function missing(error: unknown): boolean {
  return String((error as { message?: unknown })?.message ?? "").startsWith("Fly API 404:");
}
