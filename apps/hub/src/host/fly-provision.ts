/**
 * Create and destroy a tenant computer through the Fly Machines API.
 *
 * `fly-machine.ts` covers the verbs an existing guest needs (wake, suspend,
 * stop). This is the other half: a tenant that can be created rather than
 * declared. `fly deploy` is a client of the same API, so nothing here is a
 * private path; what it replaces is a human writing `fly.<tenant>.toml`,
 * running `fly apps create`, `fly volumes create` and `fly deploy`, then
 * adding the tenant to `COMPUTER_BINDINGS` on the control plane.
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
 * Every computer is the same computer, so `ComputerSpec` is three fields and
 * there are no options. The guest size, the region, the volume size and the
 * suspend behaviour are constants, not settings: nothing has yet needed two
 * computers to differ in any of them, and the first thing that does is a
 * better moment to add the knob than now.
 *
 * There is no `env` parameter, and that absence is the point. Fly delivers app
 * secrets to the guest as environment variables, so an `env` here would boot a
 * guest carrying a setup code perfectly well, and a Machine's `config.env`
 * reads back out of `GET /machines/<id>` where a secret does not. Set the
 * tenant's secrets on the app first (`fly secrets set -a <app>`), then create
 * the Machine, which is also the order that gets them into the first boot.
 *
 * Still not a custom Firecracker orchestrator; see the note in
 * `fly-machine.ts`. This asks Fly for a Machine, it does not run one.
 */

import { appsPath, flyCall, machinePath, volumesPath } from "./fly-machine.ts";
import type { FlyConfig, FlyFetch } from "./fly-machine.ts";

import {
  machineConfig,
  COMPUTER_REGION as REGION,
  COMPUTER_VOLUME_GB as VOLUME_GB,
} from "@computer/shared";
import type { ComputerSpec } from "@computer/shared";

export { machineConfig, PROCESS_GROUP, WORKSPACE_PATH } from "@computer/shared";
export type { ComputerSpec } from "@computer/shared";
const WORKSPACE_VOLUME = "computer_workspace";
interface CallOpts {
  cfg?: FlyConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: FlyFetch;
}

/** What a successful create leaves behind, and what a destroy needs. */
interface CreatedComputer {
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
  await flyCall(appsPath(), "POST", {
    ...opts,
    payload: { app_name: spec.app, org_slug: spec.org },
  });

  const volume = await flyCall(volumesPath(spec.app), "POST", {
    ...opts,
    payload: {
      name: WORKSPACE_VOLUME,
      region: REGION,
      size_gb: VOLUME_GB,
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
      region: REGION,
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
