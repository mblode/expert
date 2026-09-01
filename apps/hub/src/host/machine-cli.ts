/**
 * Cloud computer host control. Local path is still `npm run up` / docker compose.
 *
 *   npm run machine -- status
 *   npm run machine -- wake
 *   npm run machine -- sleep      # v1: stop the Machine
 *   npm run machine -- suspend    # Grok-like: memory snapshot when eligible
 *
 * Needs FLY_API_TOKEN and FLY_APP_NAME (and FLY_MACHINE_ID if the app has
 * more than one Machine). Tokens stay in the environment — never in git.
 */
import { flyRequest, guestState, resolveFlyConfig } from "./fly-machine.ts";

const USAGE = [
  "usage:",
  "  npm run machine -- status    Fly Machine state (running / hibernated / stopped)",
  "  npm run machine -- wake      start (resume from suspend, or cold start)",
  "  npm run machine -- sleep     stop — processes die; volumes persist (v1)",
  "  npm run machine -- suspend   memory snapshot if the Machine is eligible",
].join("\n");

const [cmd] = process.argv.slice(2);

try {
  switch (cmd) {
    case "status":
      await status();
      break;
    case "wake":
    case "start":
      await act("wake", "waking");
      break;
    case "sleep":
    case "stop":
      await act("sleep", "sleeping (stop)");
      break;
    case "suspend":
      await act("suspend", "suspending");
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      console.error(`unknown command: ${cmd}\n${USAGE}`);
      process.exit(1);
  }
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : err}`);
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
    console.log("volumes  /workspace, ~/.config, /data — still there");
    console.log("wake     npm run machine -- wake   (or open the public HTTPS URL)");
  }
}

async function act(action: "wake" | "sleep" | "suspend", label: string): Promise<void> {
  const { machine } = await flyRequest(action);
  console.log(`${label} ${machine}`);
}
