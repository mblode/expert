import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import type { Desk } from "./desk/types.ts";
import { AuthRegistry, tokenFromRequest } from "./handler/auth.ts";
import { ConnectRouter, corsHeaders, writeError, writeJson } from "./handler/router.ts";
import { registerAgent } from "./handler/agent.ts";
import { registerSeat } from "./handler/seat.ts";
import { handleEveProxy, isEvePath } from "./handler/eve-proxy.ts";
import { handleChannelIngress, isChannelPath } from "./handler/channels.ts";
import { registerWhatsApp } from "./handler/whatsapp.ts";
import { ChannelRegistry } from "./service/channels.ts";
import type { ChannelStore } from "./service/channels.ts";
import type { BridgeClient } from "./service/whatsapp.ts";
import { eveUrlForDisplay } from "./host/eve.ts";
import { needsSeatPixelAuth, serveStatic } from "./handler/static.ts";
import { BotRegistry } from "./service/bots.ts";
import type { PolicyService } from "./service/policy.ts";
import { ProvisionService } from "./service/provision.ts";
import type { BotStore, SeatTokenStore } from "./service/provision.ts";
import type { WindowManager } from "./desk/windows.ts";
import { loadSpecJson } from "./service/spec.ts";
import type { PixelRegistry } from "./service/pixels.ts";
import { attachVncProxy } from "./vnc-proxy.ts";
import { readHealth } from "./service/health.ts";

export interface HubOptions {
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
  /**
   * Per-bot Eve URLs. Absent entries are derived from display
   * (`127.0.0.1:2000+(display-1)`). Pass `{ main: "" }` to force DAEMON_DOWN.
   */
  eveUrls?: Record<string, string>;
  /** Shared secret injected on hub→Eve loopback requests (`eve start`). */
  eveSecret?: string;
  /** Persists channel doors (the WhatsApp bridge, webhooks). Memory in tests. */
  channelStore?: ChannelStore;
  /** The WhatsApp bridge this hub supervises. Absent = the RPCs answer DAEMON_DOWN. */
  bridge?: BridgeClient;
  /** The supervisor's status file (init writes it). Absent = /healthz reports the hub alone. */
  statusFile?: string;
}

export interface Hub {
  server: Server;
  wss: WebSocketServer;
  auth: AuthRegistry;
  bots: BotRegistry;
  provision: ProvisionService;
  channels: ChannelRegistry;
  router: ConnectRouter;
  /** Mounts the stored roster (or provisions "main") and claims windows. */
  start: () => Promise<void>;
  close: () => Promise<void>;
}

export function createHub(opts: HubOptions): Hub {
  const bots = new BotRegistry(opts.deskFactory, opts.store.load(), opts.policy);
  const provision = new ProvisionService(bots, opts.windows, opts.store);
  const auth = new AuthRegistry({
    agentTokens: () => bots.tokenEntries(),
    pixels: opts.pixels,
    seats: opts.seatStore,
    setupCode: opts.setupCode,
  });
  const router = new ConnectRouter(auth);
  const channels = new ChannelRegistry(opts.channelStore);

  registerAgent(router, bots);
  registerSeat(router, { auth, bots, provision, vncUrl: opts.vncUrl });
  registerWhatsApp(router, { bots, bridge: opts.bridge, channels });

  router.extra("GET", "/spec", "public", async () => loadSpecJson());
  // Honest health: the supervisor's view of desk, Eve and bridge beside the
  // hub's own. Always 200 while the hub answers, so a crash-looping Eve does
  // not make the platform restart the whole Machine; `ok` and `children`
  // carry the detail for the owner page and for a person reading it.
  router.extra("GET", "/healthz", "public", async () => readHealth(opts.statusFile));
  // bot.roster equivalent: ids and screens, never tokens. Cold on the edge.
  router.extra("GET", "/roster", "seat", async () => ({
    bots: bots.all().map((b) => ({ display: b.display, id: b.id, state: b.seat.getState() })),
  }));

  router.assertAllPolicies();

  const staticDir = resolve(import.meta.dirname, "static");
  const eveSecret = opts.eveSecret ?? process.env.COMPUTER_EVE_SECRET;
  // Resolved per request: the roster changes at runtime (CreateBot), and at
  // construction time a fresh box has no primary yet.
  // Resolved per request: the roster changes at runtime (CreateBot), and at
  // construction time a fresh box has no primary yet. Empty string = no Eve.
  const eveUrl = (botId: string, display: number): string => {
    const override = process.env.COMPUTER_EVE_URL;
    if (opts.eveUrls) {
      return opts.eveUrls[botId] ?? eveUrlForDisplay(display);
    }
    if (override && botId === bots.primary().id) {
      return override;
    }
    return eveUrlForDisplay(display);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }
      // Before the Connect router: one origin and one credential for the
      // clients: Eve's own protocol, gated by the seat token.
      if (isEvePath(url.pathname)) {
        await handleEveProxy(req, res, { auth, bots, cors: corsHeaders(), eveSecret, eveUrl });
        return;
      }
      // The other door: a channel secret, not a seat. Same Eve, same hub secret.
      if (isChannelPath(url.pathname)) {
        await handleChannelIngress(req, res, {
          bots,
          channels,
          cors: corsHeaders(),
          eveSecret,
          eveUrl,
        });
        return;
      }
      const handled = await router.handle(req, res);
      if (handled) {
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        // Pixels (the noVNC page and its websocket) are the only static
        // content, and they need a seat or pixel token. The product web is
        // the Vercel app; the hub serves no panel.
        if (needsSeatPixelAuth(url.pathname) && !auth.canViewPixels(tokenFromRequest(req))) {
          writeJson(res, 401, {
            error: { code: "UNAUTHENTICATED", message: "seat or pixel token required" },
          });
          return;
        }
        if (serveStatic(res, staticDir, url.pathname)) {
          return;
        }
      }
      writeJson(res, 404, { error: { code: "VALIDATION", message: "not found" } });
    } catch (error) {
      writeError(res, error);
    }
  });

  // Token checked on the upgrade (a bad one is refused before the socket
  // opens); the display binding is checked once the URL is parsed in the proxy.
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { req: IncomingMessage }) =>
      auth.canViewPixels(tokenFromRequest(info.req)),
  });
  attachVncProxy(wss, {
    auth,
    basePort: opts.vncBasePort ?? 5900,
    hasDisplay: (display) => bots.hasDisplay(display),
    host: opts.vncHost ?? "127.0.0.1",
  });

  return {
    auth,
    bots,
    channels,
    close: () =>
      new Promise((resolveClose) => {
        wss.close();
        server.close(() => resolveClose());
      }),
    provision,
    router,
    server,
    start: () => provision.start(),
    wss,
  };
}
