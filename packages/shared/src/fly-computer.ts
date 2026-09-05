/** Where a created guest mounts its volume. Matches `fly.toml` and the Dockerfile. */
export const WORKSPACE_PATH = "/workspace";
/**
 * The process group `fly-machine.ts` looks for when an app has several
 * Machines and no `FLY_MACHINE_ID`. A created Machine that omits it is a
 * Machine the wake path cannot find.
 */
export const PROCESS_GROUP = "computer";
/** Both tenants live here, and a volume cannot move between regions anyway. */
export const COMPUTER_REGION = "syd";
/** `/workspace` holds the desk files, the roster and Eve's build. */
export const COMPUTER_VOLUME_GB = 10;

/**
 * What a tenant computer is.
 *
 * Only what actually differs between two of them. Everything else is a
 * constant above, because every computer runs the same guest at the same size
 * in the same region: a knob for the size or the region would be a setting
 * nobody has yet had a reason to set, and the first real reason is a better
 * time to add it than now.
 *
 * There is deliberately no `env`. Fly delivers app secrets to the guest as
 * environment variables, so an `env` here would boot fine carrying a setup
 * code, and `config.env` reads back out of `GET /machines/<id>` where a secret
 * does not. Having no parameter makes that impossible rather than checked.
 * Set the tenant's secrets on the app first (`fly secrets set`), then create.
 */
export interface ComputerSpec {
  /** Fly app name, and so the tenant's hostname: `<app>.fly.dev`. */
  app: string;
  /** Fly organisation slug the app is created under. */
  org: string;
  /** Guest image reference, the one `deploy/fly/Dockerfile` produced. */
  image: string;
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
    },
    guest: {
      cpu_kind: "shared",
      // Chromium, Xvfb, Eve and the hub do not fit in 1 GB, and one vCPU
      // stutters VNC while Eve drives the desk. 2 GB is also Fly's ceiling for
      // a suspendable Machine, so a bigger guest trades wake for headroom.
      cpus: 2,
      memory_mb: 2048,
    },
    image: spec.image,
    metadata: { fly_process_group: PROCESS_GROUP },
    mounts: [{ path: WORKSPACE_PATH, volume: volumeId }],
    restart: { policy: "always" },
    services: [
      {
        autostart: true,
        autostop: "suspend",
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
