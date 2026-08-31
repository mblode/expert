import { createHub } from "./app.ts";
import { createDesk } from "./desk/index.ts";

const bind = process.env.COMPUTER_BIND ?? "127.0.0.1";
if (bind !== "127.0.0.1" && bind !== "localhost") {
  console.error("refusing to bind", bind, "— hub must stay on loopback; use Tailscale Serve");
  process.exit(1);
}

const port = Number(process.env.COMPUTER_PORT ?? 8787);
const publicUrl = process.env.COMPUTER_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const vncUrl =
  process.env.COMPUTER_VNC_URL ?? `${publicUrl.replace(/\/$/, "")}/vnc/index.html?view_only=1`;

const hub = createHub({
  desk: createDesk(),
  setupCode: process.env.COMPUTER_SETUP_CODE ?? "",
  agentToken: process.env.COMPUTER_AGENT_TOKEN ?? "",
  vncUrl,
  publicUrl,
  vncHost: process.env.COMPUTER_VNC_HOST ?? "127.0.0.1",
  vncPort: Number(process.env.COMPUTER_VNC_PORT ?? 5900),
  apiKey: process.env.OPENAI_API_KEY,
  llmBaseUrl: process.env.OPENAI_BASE_URL,
  llmModel: process.env.OPENAI_MODEL,
});

hub.server.listen(port, bind, () => {
  console.log(`computer hub on http://${bind}:${port}`);
  console.log(`vncUrl ${vncUrl}`);
  console.log(`seat ${hub.seat.getState()}`);
});
