/**
 * Cloud computer host control. Local path is still `npm run up` / docker compose.
 *
 *   npm run machine -- status
 *   npm run machine -- wake
 *   npm run machine -- sleep      # v1: stop the Machine
 *   npm run machine -- suspend    # Grok-like: memory snapshot when eligible
 *
 * Needs FLY_API_TOKEN and FLY_APP_NAME (and FLY_MACHINE_ID if the app has
 * more than one Machine). Tokens stay in the environment, never in git.
 */
import { flyRequest, guestState, resolveFlyConfig } from "./fly-machine.ts";
import { createComputer, destroyComputer } from "./fly-provision.ts";

const USAGE = [
  "usage:",
  "  npm run machine -- status    Fly Machine state (running / hibernated / stopped)",
  "  npm run machine -- wake      start (resume from suspend, or cold start)",
  "  npm run machine -- sleep     stop: processes die; volumes persist (v1)",
  "  npm run machine -- suspend   memory snapshot if the Machine is eligible",
  "",
  "  npm run machine -- create <app> <org> <image> [region]",
  "                               app + volume + Machine for a new tenant",
  "  npm run machine -- destroy <app>",
  "                               delete the app, and its Machines and volumes with it",
  "",
  "  create sets no secrets: put COMPUTER_SETUP_CODE on the app first",
  "  (fly secrets set -a <app> ...), or the guest boots with none.",
].join("\n");

const [cmd] = process.argv.slice(2);

try {
  switch (cmd) {
    case "status": {
      await status();
      break;
    }
    case "wake":
    case "start": {
      await act("wake", "waking");
      break;
    }
    case "sleep":
    case "stop": {
      await act("sleep", "sleeping (stop)");
      break;
    }
    case "suspend": {
      await act("suspend", "suspending");
      break;
    }
    case "create": {
      await create();
      break;
    }
    case "destroy": {
      await destroy();
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      console.log(USAGE);
      break;
    }
    default: {
      console.error(`unknown command: ${cmd}\n${USAGE}`);
      process.exit(1);
    }
  }
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

async function status(): Promise<void> {
  const { body, machine } = await flyRequest("status");
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const fly = rec.state ?? rec.status ?? "unknown";
  const guest = guestState(fly);
  const cfg = resolveFlyConfig();
  console.log(`app      ${cfg.app}`);
  console.log(`machine  ${machine}`);
  console.log(`fly      ${fly}`);
  console.log(`guest    ${guest}`);
  if (guest === "stopped" || guest === "hibernated") {
    console.log("volumes  /workspace (roster + Eve secret under .computer), still there");
    console.log("wake     npm run machine -- wake   (or open the public HTTPS URL)");
  }
}

async function act(action: "wake" | "sleep" | "suspend", label: string): Promise<void> {
  const { machine } = await flyRequest(action);
  console.log(`${label} ${machine}`);
}

/**
 * Provision a tenant. Deliberately positional and unforgiving: this creates
 * billable resources, and a typo in the app name is a second tenant nobody
 * asked for rather than an edit to an existing one.
 */
async function create(): Promise<void> {
  const [app, org, image, region = "syd"] = process.argv.slice(3);
  if (!(app && org && image)) {
    console.error(`create needs <app> <org> <image> [region]\n${USAGE}`);
    process.exit(1);
  }
  const created = await createComputer({ app, image, org, region });
  console.log(`app      ${created.app}`);
  console.log(`machine  ${created.machineId}`);
  console.log(`volume   ${created.volumeId}`);
  console.log(`hub      ${created.hubUrl}`);
  console.log("");
  console.log(`next     fly secrets set -a ${created.app} COMPUTER_SETUP_CODE=...`);
  console.log("         then add the tenant to COMPUTER_CATALOG on the control plane");
}

async function destroy(): Promise<void> {
  const [app] = process.argv.slice(3);
  if (!app) {
    console.error(`destroy needs <app>\n${USAGE}`);
    process.exit(1);
  }
  await destroyComputer(app);
  console.log(`destroyed ${app} (Machines and volumes with it)`);
}
