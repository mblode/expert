import { createServer, type IncomingMessage, type Server } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import type { Desk } from "./desk/types.ts";
import { AuthRegistry, tokenFromRequest } from "./handler/auth.ts";
import { ConnectRouter, corsHeaders, writeError, writeJson } from "./handler/router.ts";
import { registerAgent } from "./handler/agent.ts";
import { registerSeat } from "./handler/seat.ts";
import { handleChat } from "./handler/chat.ts";
import { DEFAULT_EVE_URL, handleEveProxy, isEvePath } from "./handler/eve-proxy.ts";
import { needsSeatPixelAuth, serveStatic } from "./handler/static.ts";
import { BotRegistry } from "./service/bots.ts";
import { PolicyService } from "./service/policy.ts";
import { ProvisionService, type BotStore, type SeatTokenStore } from "./service/provision.ts";
import type { WindowManager } from "./desk/windows.ts";
import { loadSpecJson } from "./service/spec.ts";
import { PixelRegistry } from "./service/pixels.ts";
import { attachVncProxy } from "./vnc-proxy.ts";

export type HubOptions = {
  setupCode: string;
  /** Builds the per-screen desk driver; the registry mounts one per Bot. */
  deskFactory: (display: number) => Desk;
  /** Claims/releases windows on the box; NoopWindowManager outside Docker. */
  windows: WindowManager;
  /** Persists the roster; FileBotStore in production, MemoryBotStore in tests. */
  store: BotStore;
  /** Persists paired seat tokens. Without it every restart unpairs every phone. */
  seatStore: SeatTokenStore;
  /** Hub-side approval gate. Absent = no rules = allow. */
  policy?: PolicyService;
  vncUrl: string;
  vncHost?: string;
  /** RFB port for window N is vncBasePort + N (primary :1 → 5901). */
  vncBasePort?: number;
  /** Short-lived noVNC tokens. Default: 15-minute in-memory grants. */
  pixels?: PixelRegistry;
  apiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  /** Where the Eve agent listens; the hub proxies /eve/v1/* to it. */
  eveUrl?: string;
  /**
   * Optional leftover static files (`apps/web/out`). Product web is the Vercel
   * Next app; the hub no longer requires an export. Absent = no panel, and
   * the hub still serves pixels and RPCs.
   */
  webDir?: string;
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
  const bots = new BotRegistry(opts.deskFactory, opts.store.load(), opts.policy);
  const provision = new ProvisionService(bots, opts.windows, opts.store);
  const auth = new AuthRegistry({
    setupCode: opts.setupCode,
    agentTokens: () => bots.tokenEntries(),
    seats: opts.seatStore,
    pixels: opts.pixels,
  });
  const router = new ConnectRouter(auth);

  registerAgent(router, bots);
  registerSeat(router, { auth, bots, provision, vncUrl: opts.vncUrl });

  router.extra("GET", "/spec", "public", async () => loadSpecJson());
  router.extra("GET", "/healthz", "public", async () => ({ ok: true }));
  // bot.roster equivalent — ids and screens, never tokens. Cold on the edge.
  router.extra("GET", "/roster", "seat", async () => ({
    bots: bots.all().map((b) => ({ id: b.id, display: b.display, state: b.seat.getState() })),
  }));

  router.assertAllPolicies();

  const staticDir = resolve(import.meta.dirname, "static");
  // Env fallback for the same reason as eveUrl below: a hub started straight
  // from createHub should still find the panel without threading an option.
  const webDir =
    opts.webDir ??
    process.env.COMPUTER_WEB_DIR ??
    resolve(import.meta.dirname, "../../web/out");
  // Env fallback so a hub started straight from createHub (tests) can be aimed
  // at another Eve without threading the option through every caller.
  const eveUrl = opts.eveUrl ?? process.env.COMPUTER_EVE_URL ?? DEFAULT_EVE_URL;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }
      // Before the Connect router: one origin and one credential for the
      // clients — Eve's own protocol, gated by the seat token.
      if (isEvePath(url.pathname)) {
        await handleEveProxy(req, res, { auth, eveUrl, cors: corsHeaders() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/chat") {
        await handleChat(req, res, { bots, auth, apiKey: opts.apiKey, llmBaseUrl: opts.llmBaseUrl, llmModel: opts.llmModel });
        return;
      }
      const handled = await router.handle(req, res);
      if (handled) return;
      if (req.method === "GET" || req.method === "HEAD") {
        const pixels = needsSeatPixelAuth(url.pathname);
        if (pixels && !auth.canViewPixels(tokenFromRequest(req))) {
          writeJson(res, 401, { error: { code: "UNAUTHENTICATED", message: "seat or pixel token required" } });
          return;
        }
        // The panel wins `/`; the hub's own static dir keeps the pixels and the
        // novnc bundle. Checked in this order so an unbuilt panel cannot shadow
        // a gated path, and a built one cannot be shadowed by the debug page.
        if (!pixels && serveStatic(req, res, webDir, url.pathname)) return;
        if (serveStatic(req, res, staticDir, url.pathname)) return;
      }
      writeJson(res, 404, { error: { code: "VALIDATION", message: "not found" } });
    } catch (err) {
      writeError(res, err);
    }
  });

  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { req: IncomingMessage }) => auth.canViewPixels(tokenFromRequest(info.req)),
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
