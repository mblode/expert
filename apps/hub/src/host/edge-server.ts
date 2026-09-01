/**
 * Always-on Fly edge: public HTTPS. The guest Machine sleeps.
 * Status / roster never call start. VNC and other use wake the guest.
 * Idle suspend is 20 minutes, not 30 seconds.
 *
 * HTTP is `fetch` to the guest hub. WebSockets cannot go through `fetch` —
 * `upgrade` is a raw TCP splice onto the guest :8080 over 6PN.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ComputerError } from "@computer/shared";
import { flyRequest, type FlyFetch } from "./fly-machine.ts";
import {
  edgeDecide,
  hibernatedBody,
  isColdPath,
  pickComputerMachine,
  recordUse,
  recordsUse,
} from "./edge.ts";
import {
  DEFAULT_ACTIVITY_INTERVAL_MS,
  DEFAULT_GUEST_PORT,
  guestHttpUrl,
  isUpgradeRequest,
  proxyWebSocket,
  throttle,
} from "./ws-proxy.ts";

export type EdgeServerOpts = {
  env?: NodeJS.ProcessEnv;
  fetch?: FlyFetch;
  now?: () => number;
  idleSuspendMs?: number;
  lastUse?: { t: number };
  guestPort?: number;
  activityIntervalMs?: number;
};

export type EdgeRuntime = {
  server: Server;
  lastUse: { t: number };
  guestId: () => string;
  idleSuspendMs: number;
};

export function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

export function createEdgeServer(opts: EdgeServerOpts = {}): EdgeRuntime {
  const env = opts.env ?? process.env;
  const lastUse = opts.lastUse ?? { t: (opts.now ?? Date.now)() };
  const idleSuspendMs = opts.idleSuspendMs ?? Number(env.COMPUTER_IDLE_SUSPEND_SEC ?? 1200) * 1000;
  const guestPort = opts.guestPort ?? Number(env.COMPUTER_GUEST_PORT ?? DEFAULT_GUEST_PORT);
  const activityIntervalMs = opts.activityIntervalMs ?? DEFAULT_ACTIVITY_INTERVAL_MS;
  let guestId = env.COMPUTER_FLY_MACHINE ?? "";

  const fly = (action: Parameters<typeof flyRequest>[0], machine?: string) =>
    flyRequest(action, {
      env: machine ? { ...env, FLY_MACHINE_ID: machine } : env,
      fetch: opts.fetch,
    });

  const bumpUse = (path: string): void => {
    if (recordsUse(path)) recordUse(lastUse, opts.now?.() ?? Date.now());
  };

  const server = createServer(async (req, res) => {
    try {
      const path = requestPath(req);
      if (path === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, role: "edge" }));
        return;
      }
      const decision = await edgeDecide(path, { env, fetch: opts.fetch });
      if (decision.guest?.id) guestId = decision.guest.id;

      if (decision.action === "cold") {
        if (decision.guestState === "running" && decision.guest?.private_ip) {
          await proxyToGuest(req, res, decision.guest.private_ip, guestPort);
          return;
        }
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify(hibernatedBody()));
        return;
      }

      bumpUse(path);
      if (decision.action === "wake" && decision.guest?.id) {
        await waitForGuest(decision.guest.id, env, opts.fetch);
      }
      const listed = await fly("list");
      const machines = Array.isArray(listed.body) ? listed.body : [];
      const guest = pickComputerMachine(machines);
      if (!guest?.private_ip) {
        throw new ComputerError("DAEMON_DOWN", "guest has no private ip yet");
      }
      await proxyToGuest(req, res, guest.private_ip, guestPort);
    } catch (err) {
      const message = err instanceof Error ? err.message : "edge";
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "DAEMON_DOWN", message } }));
    }
  });

  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      const path = requestPath(req);
      if (isColdPath(path) || !isUpgradeRequest(req)) {
        socket.destroy();
        return;
      }
      try {
        const decision = await edgeDecide(path, { env, fetch: opts.fetch });
        if (decision.guest?.id) guestId = decision.guest.id;
        if (decision.action === "cold") {
          socket.destroy();
          return;
        }
        bumpUse(path);
        if (decision.action === "wake" && decision.guest?.id) {
          await waitForGuest(decision.guest.id, env, opts.fetch);
        }
        const listed = await fly("list");
        const machines = Array.isArray(listed.body) ? listed.body : [];
        const guest = pickComputerMachine(machines);
        if (!guest?.private_ip) {
          socket.destroy();
          return;
        }
        const onActivity = throttle(() => bumpUse(path), activityIntervalMs, opts.now ?? Date.now);
        await proxyWebSocket(req, socket, head, guest.private_ip, {
          port: guestPort,
          onActivity,
        });
      } catch {
        socket.destroy();
      }
    })();
  });

  return {
    server,
    lastUse,
    guestId: () => guestId,
    idleSuspendMs,
  };
}

async function waitForGuest(id: string, env: NodeJS.ProcessEnv, fetch?: FlyFetch): Promise<void> {
  await flyRequest("wake", { env: { ...env, FLY_MACHINE_ID: id }, fetch });
  for (let i = 0; i < 40; i++) {
    const st = await flyRequest("status", { env: { ...env, FLY_MACHINE_ID: id }, fetch });
    const body = st.body as { state?: string };
    if (body?.state === "started") return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function proxyToGuest(
  req: IncomingMessage,
  res: ServerResponse,
  ip: string,
  port: number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const target = guestHttpUrl(ip, `${url.pathname}${url.search}`, port);
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
