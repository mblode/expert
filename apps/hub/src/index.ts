import { dirname, join, resolve } from "node:path";
import { createHub } from "./app.ts";
import { DEFAULT_EVE_URL } from "./handler/eve-proxy.ts";
import { createDesk, DockerWindowManager, NoopWindowManager } from "./desk/index.ts";
import { loadPolicy } from "./service/policy.ts";
import { createIdentityVerifier, FileIdentityStore } from "./service/identity.ts";
import { FileBotStore, FileSeatTokenStore } from "./service/provision.ts";

const bind = process.env.COMPUTER_BIND ?? "127.0.0.1";
if (bind !== "127.0.0.1" && bind !== "localhost") {
  console.error("refusing to bind", bind, "— hub must stay on loopback; use Tailscale Serve");
  process.exit(1);
}

const port = Number(process.env.COMPUTER_PORT ?? 8787);
const publicUrl = process.env.COMPUTER_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const vncUrl =
  process.env.COMPUTER_VNC_URL ?? `${publicUrl.replace(/\/$/, "")}/vnc/index.html?view_only=1`;
const dockerMode = (process.env.COMPUTER_DESK ?? "fake") === "docker";
// Paired seats and policy live beside the roster, wherever the operator put it.
const rosterPath = resolve(process.env.COMPUTER_DATA ?? "data/bots.json");
const dataDir = dirname(rosterPath);

const hub = createHub({
  setupCode: process.env.COMPUTER_SETUP_CODE ?? "",
  deskFactory: createDesk,
  windows: dockerMode
    ? new DockerWindowManager(process.env.COMPUTER_DESK_CONTAINER ?? "computer-desk")
    : new NoopWindowManager(),
  store: new FileBotStore(rosterPath),
  seatStore: new FileSeatTokenStore(join(dataDir, "seats.json")),
  identity: createIdentityVerifier({
    jwtSecret: process.env.SUPABASE_JWT_SECRET,
    supabaseUrl: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  }),
  identityStore: new FileIdentityStore(join(dataDir, "identities.json")),
  policy: loadPolicy(join(dataDir, "policy.json")),
  vncUrl,
  vncHost: process.env.COMPUTER_VNC_HOST ?? "127.0.0.1",
  // RFB port for window N is base + N (primary :1 → 5901).
  vncBasePort: Number(process.env.COMPUTER_VNC_PORT ?? 5900),
  apiKey: process.env.OPENAI_API_KEY,
  llmBaseUrl: process.env.OPENAI_BASE_URL,
  llmModel: process.env.OPENAI_MODEL,
  eveUrl: process.env.COMPUTER_EVE_URL ?? DEFAULT_EVE_URL,
});

await hub.start();

hub.server.listen(port, bind, () => {
  console.log(`computer hub on http://${bind}:${port}`);
  console.log(`vncUrl ${vncUrl}`);
  console.log(
    `bots ${hub.bots
      .all()
      .map((b) => `${b.id}:${b.display}`)
      .join(" ")}`,
  );
});
