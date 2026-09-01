import { createServer, type IncomingMessage, type Server } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import type { Desk } from "./desk/types.ts";
import { AuthRegistry, tokenFromRequest } from "./handler/auth.ts";
import { ConnectRouter, writeError, writeJson } from "./handler/router.ts";
import { registerAgent } from "./handler/agent.ts";
import { registerSeat } from "./handler/seat.ts";
import { handleChat } from "./handler/chat.ts";
import { needsSeatPixelAuth, serveStatic } from "./handler/static.ts";
import { BotRegistry } from "./service/bots.ts";
import { ProvisionService, type BotStore } from "./service/provision.ts";
import type { WindowManager } from "./desk/windows.ts";
import { loadSpecJson } from "./service/spec.ts";
import { attachVncProxy } from "./vnc-proxy.ts";

export type HubOptions = {
  setupCode: string;
  /** Builds the per-screen desk driver; the registry mounts one per Bot. */
  deskFactory: (display: number) => Desk;
  /** Claims/releases windows on the box; NoopWindowManager outside Docker. */
  windows: WindowManager;
  /** Persists the roster; FileBotStore in production, MemoryBotStore in tests. */
  store: BotStore;
  vncUrl: string;
  vncHost?: string;
  /** RFB port for window N is vncBasePort + N (primary :1 → 5901). */
  vncBasePort?: number;
  apiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
};

export type Hub = {
  server: Server;
  wss: WebSocketServer;
  auth: AuthRegistry;
  bots: BotRegistry;
  provision: ProvisionService;
  router: ConnectRouter;
  /** Mounts the stored roster (or provisions "main") and claims windows. */
  start: () => Promise<void>;
  close: () => Promise<void>;
};

export function createHub(opts: HubOptions): Hub {
  const bots = new BotRegistry(opts.deskFactory, opts.store.load());
  const provision = new ProvisionService(bots, opts.windows, opts.store);
  const auth = new AuthRegistry({
    setupCode: opts.setupCode,
    agentTokens: () => bots.tokenEntries(),
  });
  const router = new ConnectRouter(auth);

  registerAgent(router, bots);
  registerSeat(router, { auth, bots, provision, vncUrl: opts.vncUrl });

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
        await handleChat(req, res, { bots, auth, apiKey: opts.apiKey, llmBaseUrl: opts.llmBaseUrl, llmModel: opts.llmModel });
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
    verifyClient: (info: { req: IncomingMessage }) => auth.hasSeatToken(tokenFromRequest(info.req)),
  });
  attachVncProxy(wss, {
    host: opts.vncHost ?? "127.0.0.1",
    basePort: opts.vncBasePort ?? 5900,
    auth,
    hasDisplay: (display) => bots.hasDisplay(display),
  });

  return {
    server,
    wss,
    auth,
    bots,
    provision,
    router,
    start: () => provision.start(),
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
