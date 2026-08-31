import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { AgentMethods } from "@computer/proto";
import type { Desk } from "./desk/types.ts";
import { AuthRegistry, tokenFromRequest } from "./handler/auth.ts";
import { ConnectRouter, writeError, writeJson } from "./handler/router.ts";
import { registerAgent } from "./handler/agent.ts";
import { registerSeat } from "./handler/seat.ts";
import { ComputerService } from "./service/computer.ts";
import { FileService } from "./service/files.ts";
import { SeatService } from "./service/seat.ts";
import { loadSpecJson } from "./service/spec.ts";
import { runChat } from "./service/chat.ts";
import { attachVncProxy } from "./vnc-proxy.ts";

export type HubOptions = {
  desk: Desk;
  setupCode: string;
  agentToken: string;
  vncUrl: string;
  publicUrl?: string;
  vncHost?: string;
  vncPort?: number;
  apiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
};

export type Hub = {
  server: Server;
  wss: WebSocketServer;
  auth: AuthRegistry;
  seat: SeatService;
  computer: ComputerService;
  files: FileService;
  router: ConnectRouter;
  desk: Desk;
  close: () => Promise<void>;
};

export function createHub(opts: HubOptions): Hub {
  const auth = new AuthRegistry({ setupCode: opts.setupCode, agentToken: opts.agentToken });
  const seat = new SeatService();
  const computer = new ComputerService(opts.desk, seat);
  const files = new FileService(opts.desk, seat);
  const router = new ConnectRouter(auth);

  registerAgent(router, computer, files);
  registerSeat(router, { auth, seat, desk: opts.desk, vncUrl: opts.vncUrl });

  router.extra("GET", "/spec", "public", async () => loadSpecJson());
  router.extra("GET", "/healthz", "public", async () => ({ ok: true }));

  router.assertAllPolicies();

  const staticDir = resolve(import.meta.dirname, "static");

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/chat") {
        await handleChat(req, res, { computer, files, seat, auth, apiKey: opts.apiKey, llmBaseUrl: opts.llmBaseUrl, llmModel: opts.llmModel });
        return;
      }
      const handled = await router.handle(req, res);
      if (handled) return;
      if (req.method === "GET" || req.method === "HEAD") {
        if (needsSeatPixelAuth(url.pathname) && !auth.hasSeatToken(tokenFromRequest(req))) {
          writeJson(res, 401, { error: { code: "UNAUTHENTICATED", message: "seat token required" } });
          return;
        }
        if (serveStatic(req, res, staticDir, url.pathname)) return;
      }
      writeJson(res, 404, { error: { code: "VALIDATION", message: "not found" } });
    } catch (err) {
      writeError(res, err);
    }
  });

  const wss = new WebSocketServer({
    server,
    verifyClient: (info) => auth.hasSeatToken(tokenFromRequest(info.req)),
  });
  attachVncProxy(wss, {
    host: opts.vncHost ?? "127.0.0.1",
    port: opts.vncPort ?? 5900,
    auth,
  });

  return {
    server,
    wss,
    auth,
    seat,
    computer,
    files,
    router,
    desk: opts.desk,
    close: () =>
      new Promise((resolveClose) => {
        wss.close();
        server.close(() => resolveClose());
      }),
  };
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, connect-protocol-version",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    computer: ComputerService;
    files: FileService;
    seat: SeatService;
    auth: AuthRegistry;
    apiKey?: string;
    llmBaseUrl?: string;
    llmModel?: string;
  },
): Promise<void> {
  const bearer = tokenFromRequest(req);
  deps.auth.verify("seat", bearer);

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let message = "";
  try {
    const body = JSON.parse(chunks.length ? Buffer.concat(chunks).toString("utf8") : "{}") as {
      message?: string;
    };
    message = body.message ?? "";
  } catch {
    writeJson(res, 400, { error: { code: "VALIDATION", message: "invalid JSON" } });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  for await (const ev of runChat(
    {
      computer: deps.computer,
      files: deps.files,
      seat: deps.seat,
      apiKey: deps.apiKey,
      baseUrl: deps.llmBaseUrl,
      model: deps.llmModel,
    },
    message,
  )) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function needsSeatPixelAuth(pathname: string): boolean {
  return pathname === "/" || pathname === "/index.html" || pathname === "/vnc" || pathname.startsWith("/vnc/");
}

function serveStatic(req: IncomingMessage, res: ServerResponse, dir: string, pathname: string): boolean {
  let rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.startsWith("/vnc") && (rel === "/vnc" || rel === "/vnc/")) rel = "/vnc/index.html";
  const safe = join(dir, rel.replace(/^\/+/, ""));
  if (!safe.startsWith(dir)) return false;
  if (!existsSync(safe)) {
    // optional @novnc/novnc from node_modules
    if (rel.startsWith("/novnc/")) {
      const novnc = tryNovnc(rel.slice("/novnc/".length));
      if (novnc) {
        writeFile(res, novnc.path, novnc.body);
        return true;
      }
    }
    return false;
  }
  writeFile(res, safe, readFileSync(safe));
  void req;
  return true;
}

function writeFile(res: ServerResponse, path: string, body: Buffer): void {
  res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
  res.end(body);
}

function tryNovnc(rel: string): { path: string; body: Buffer } | null {
  const candidates = [
    resolve(process.cwd(), "node_modules/@novnc/novnc", rel),
    resolve(import.meta.dirname, "../node_modules/@novnc/novnc", rel),
    resolve(import.meta.dirname, "../../../node_modules/@novnc/novnc", rel),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, body: readFileSync(p) };
  }
  return null;
}

void AgentMethods;
