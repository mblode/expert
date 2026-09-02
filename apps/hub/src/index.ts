import { dirname, join, resolve } from "node:path";
import { createHub } from "./app.ts";
import { ensureEveSecret } from "./host/ensure-roster.ts";
import {
  createDesk,
  DockerWindowManager,
  LocalWindowManager,
  NoopWindowManager,
} from "./desk/index.ts";
import { allowedBind, refuseBindMessage } from "./host/bind.ts";
import { loadPolicy } from "./service/policy.ts";
import { FileBotStore, FileSeatTokenStore } from "./service/provision.ts";
import { FileChannelStore } from "./service/channels.ts";
import { BridgeClient, DEFAULT_BRIDGE_URL } from "./service/whatsapp.ts";
import { PixelRegistry } from "./service/pixels.ts";

const bind = process.env.COMPUTER_BIND ?? "127.0.0.1";
if (!allowedBind(bind)) {
  console.error(refuseBindMessage(bind));
  process.exit(1);
}

const port = Number(process.env.COMPUTER_PORT ?? 8787);
const publicUrl = process.env.COMPUTER_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const vncUrl =
  process.env.COMPUTER_VNC_URL ?? `${publicUrl.replace(/\/$/, "")}/vnc/index.html?view_only=1`;
const deskMode = process.env.COMPUTER_DESK ?? "fake";
// Paired seats and policy live beside the roster, wherever the operator put it.
const rosterPath = resolve(process.env.COMPUTER_DATA ?? "data/bots.json");
const dataDir = dirname(rosterPath);
const eveSecret = ensureEveSecret(join(dataDir, "eve-secret"), process.env.COMPUTER_EVE_SECRET);
// The bridge's admin secret lives beside the roster and is handed to the
// bridge child by the supervisor; the hub reads the same file. Same shape as
// the Eve secret, and for the same reason: never on argv, never in a log.
const bridgeSecret = ensureEveSecret(
  join(dataDir, "whatsapp", "bridge-secret"),
  process.env.WHATSAPP_BRIDGE_SECRET,
);

const windows =
  deskMode === "docker"
    ? new DockerWindowManager(process.env.COMPUTER_DESK_CONTAINER ?? "computer-desk")
    : deskMode === "local"
      ? new LocalWindowManager()
      : new NoopWindowManager();

const hub = createHub({
  setupCode: process.env.COMPUTER_SETUP_CODE ?? "",
  deskFactory: createDesk,
  windows,
  store: new FileBotStore(rosterPath),
  seatStore: new FileSeatTokenStore(join(dataDir, "seats.json")),
  pixels: new PixelRegistry({
    tokenDir: process.env.COMPUTER_VNC_TOKEN_DIR ?? join(dataDir, "vnc-tokens"),
    ttlMs: Number(process.env.COMPUTER_VNC_TTL_SEC ?? 900) * 1000,
  }),
  policy: loadPolicy(join(dataDir, "policy.json")),
  channelStore: new FileChannelStore(join(dataDir, "channels.json")),
  bridge: new BridgeClient({
    secret: bridgeSecret,
    url: process.env.COMPUTER_BRIDGE_URL ?? DEFAULT_BRIDGE_URL,
  }),
  statusFile: process.env.COMPUTER_STATUS_FILE,
  vncUrl,
  vncHost: process.env.COMPUTER_VNC_HOST ?? "127.0.0.1",
  // RFB port for window N is base + N (primary :1 → 5901).
  vncBasePort: Number(process.env.COMPUTER_VNC_PORT ?? 5900),
  eveSecret,
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

const shutdown = (): void => {
  void hub.close().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
