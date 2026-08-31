import { createHub, type BotOption } from "./app.ts";
import { createDesk, DockerWindowManager } from "./desk/index.ts";
import { parseBotConfigs } from "./service/bots.ts";

const bind = process.env.COMPUTER_BIND ?? "127.0.0.1";
if (bind !== "127.0.0.1" && bind !== "localhost") {
  console.error("refusing to bind", bind, "— hub must stay on loopback; use Tailscale Serve");
  process.exit(1);
}

const port = Number(process.env.COMPUTER_PORT ?? 8787);
const publicUrl = process.env.COMPUTER_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const vncUrl =
  process.env.COMPUTER_VNC_URL ?? `${publicUrl.replace(/\/$/, "")}/vnc/index.html?view_only=1`;

// Roster: COMPUTER_BOTS JSON, else one bot "main" on :1 with COMPUTER_AGENT_TOKEN.
const bots: BotOption[] | undefined = process.env.COMPUTER_BOTS
  ? parseBotConfigs(process.env.COMPUTER_BOTS).map((b) => ({ ...b, desk: createDesk(b.display) }))
  : undefined;

const hub = createHub({
  desk: createDesk(1),
  setupCode: process.env.COMPUTER_SETUP_CODE ?? "",
  agentToken: process.env.COMPUTER_AGENT_TOKEN ?? "",
  bots,
  deskFactory: createDesk,
  vncUrl,
  publicUrl,
  vncHost: process.env.COMPUTER_VNC_HOST ?? "127.0.0.1",
  // RFB port for window N is base + N (primary :1 → 5901).
  vncBasePort: Number(process.env.COMPUTER_VNC_PORT ?? 5900),
  apiKey: process.env.OPENAI_API_KEY,
  llmBaseUrl: process.env.OPENAI_BASE_URL,
  llmModel: process.env.OPENAI_MODEL,
});

if ((process.env.COMPUTER_DESK ?? "fake") === "docker") {
  const windows = new DockerWindowManager(process.env.COMPUTER_DESK_CONTAINER ?? "computer-desk");
  hub.bots
    .ensureWindows(windows)
    .catch((err) => console.error("ensureWindows:", err instanceof Error ? err.message : err));
}

hub.server.listen(port, bind, () => {
  console.log(`computer hub on http://${bind}:${port}`);
  console.log(`vncUrl ${vncUrl}`);
  console.log(
    `bots ${hub.bots
      .all()
      .map((b) => `${b.id}:${b.display}`)
      .join(" ")}`,
  );
  console.log(`seat ${hub.seat.getState()}`);
});
