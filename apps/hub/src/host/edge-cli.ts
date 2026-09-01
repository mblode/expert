/**
 * Always-on Fly edge: public HTTPS. The guest Machine sleeps.
 * Status / roster never call start. VNC and other use wake the guest.
 * Idle suspend is 20 minutes, not 30 seconds.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ComputerError } from "@computer/shared";
import { flyRequest } from "./fly-machine.ts";
import {
  edgeDecide,
  hibernatedBody,
  maybeIdleSuspend,
  pickComputerMachine,
  recordUse,
} from "./edge.ts";
import { proxyUpgradeToGuest } from "./ws-proxy.ts";

const port = Number(process.env.COMPUTER_PORT ?? 8080);
const bind = process.env.COMPUTER_BIND ?? "0.0.0.0";
const idleMs = Number(process.env.COMPUTER_IDLE_SUSPEND_SEC ?? 1200) * 1000;
const lastUse = { t: Date.now() };
let guestId = process.env.COMPUTER_FLY_MACHINE ?? "";

function pathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

async function waitForGuest(id: string): Promise<void> {
  await flyRequest("wake", { env: { ...process.env, FLY_MACHINE_ID: id } });
  for (let i = 0; i < 40; i++) {
    const st = await flyRequest("status", { env: { ...process.env, FLY_MACHINE_ID: id } });
    const body = st.body as { state?: string };
    if (body?.state === "started") return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function proxyToGuest(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const target = `http://${ip.includes(":") ? `[${ip}]` : ip}:8080${url.pathname}${url.search}`;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const upstream = await fetch(target, {
    method: req.method,
    headers: {
      authorization: String(req.headers.authorization ?? ""),
      "content-type": String(req.headers["content-type"] ?? "application/json"),
      "connect-protocol-version": String(req.headers["connect-protocol-version"] ?? "1"),
    },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "content-length": buf.length,
  });
  res.end(buf);
}

const server = createServer(async (req, res) => {
  try {
    const path = pathname(req);
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, role: "edge" }));
      return;
    }
    const decision = await edgeDecide(path);
    if (decision.guest?.id) guestId = decision.guest.id;

    if (decision.action === "cold") {
      if (decision.guestState === "running" && decision.guest?.private_ip) {
        await proxyToGuest(req, res, decision.guest.private_ip);
        return;
      }
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify(hibernatedBody()));
      return;
    }

    recordUse(lastUse);
    if (decision.action === "wake" && decision.guest?.id) {
      await waitForGuest(decision.guest.id);
    }
    const listed = await flyRequest("list");
    const machines = Array.isArray(listed.body) ? listed.body : [];
    const guest = pickComputerMachine(machines);
    if (!guest?.private_ip) {
      throw new ComputerError("DAEMON_DOWN", "guest has no private ip yet");
    }
    await proxyToGuest(req, res, guest.private_ip);
  } catch (err) {
    const message = err instanceof Error ? err.message : "edge";
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "DAEMON_DOWN", message } }));
  }
});

server.on("upgrade", (req, socket, head) => {
  void (async () => {
    try {
      const path = pathname(req);
      const decision = await edgeDecide(path);
      if (decision.guest?.id) guestId = decision.guest.id;
      recordUse(lastUse);
      if (decision.action === "wake" && decision.guest?.id) {
        await waitForGuest(decision.guest.id);
      }
      const listed = await flyRequest("list");
      const machines = Array.isArray(listed.body) ? listed.body : [];
      const guest = pickComputerMachine(machines);
      if (!guest?.private_ip) {
        socket.destroy();
        return;
      }
      proxyUpgradeToGuest(req, socket, head, guest.private_ip);
    } catch {
      socket.destroy();
    }
  })();
});

server.listen(port, bind, () => {
  console.log(`computer edge on http://${bind}:${port} (idle suspend ${idleMs / 1000}s)`);
});

setInterval(() => {
  if (!guestId) return;
  void maybeIdleSuspend(lastUse, { guestId, idleSuspendMs: idleMs }).catch((err) => {
    console.error("idle suspend", err);
  });
}, 60_000);
