import { EVE_HUB_SECRET_HEADER } from "@computer/shared";
import type { WhatsAppOwner } from "./service/whatsapp-owner.ts";
import { RoutineService } from "./service/routines.ts";
import { AssistantState } from "./service/assistant.ts";
import { workLink } from "./service/work-links.ts";
import type { ClockClient } from "./service/clock.ts";
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
import { handleConnectorIngress, isConnectorPath } from "./handler/connectors.ts";
import { registerWhatsApp } from "./handler/whatsapp.ts";
import { CodingService } from "./service/coding.ts";
import type { CodingIntentStore } from "./service/coding-intents.ts";
import { ConnectorRegistry } from "./service/connectors.ts";
import type { ConnectorStore } from "./service/connectors.ts";
import { ConversationRegistry } from "./service/conversations.ts";
import type { ConversationStore, MessageLog } from "./service/conversations.ts";
import { InboundService } from "./service/inbound.ts";
import { runEveTurn, TurnService } from "./service/turns.ts";
import type { BridgeClient } from "./service/whatsapp.ts";
import { eveUrlForDisplay } from "./host/eve.ts";
import type { ProfileSeedReader } from "./host/bot-seed.ts";
import { needsSeatPixelAuth, serveStatic } from "./handler/static.ts";
import { BotRegistry } from "./service/bots.ts";
import { ScreenKeeper } from "./service/screens.ts";
import { screenOnDemand } from "./desk/lazy.ts";
import type { PolicyService } from "./service/policy.ts";
import { ProvisionService } from "./service/provision.ts";
import type { BotStore } from "./service/provision.ts";
import { BotTemplateService } from "./service/templates.ts";
import type { AskEveFn, TemplateSourceReader } from "./service/templates.ts";
import type { PrincipalStore } from "./service/principals.ts";
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
  /** Persists every principal: seats, and the issuers a control plane holds.
   * Without it every restart unpairs every phone. */
  principalStore: PrincipalStore;
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
  /** Persists connector doors (the WhatsApp bridge, webhooks). Memory in tests. */
  connectorStore?: ConnectorStore;
  /** The conversation index and its append-only logs. Memory in tests. */
  conversationStore?: ConversationStore;
  messageLog?: MessageLog;
  /** The WhatsApp bridge this hub supervises. Absent = the RPCs answer DAEMON_DOWN. */
  bridge?: BridgeClient;
  /**
   * Delegated coding sessions. A factory, like `deskFactory`, because the
   * service records into the hub's own conversation store and that store is
   * built here: handing in a finished service would hand in one wired to a
   * different log. Absent = built from the environment.
   */
  codingFactory?: (conversations: ConversationRegistry) => CodingService;
  codingIntents?: CodingIntentStore;
  turnStorePath?: string;
  inboundStorePath?: string;
  assistantStorePath?: string;
  routineStorePath?: string;
  paOwner?: { acct: string; jid: string };
  sharedWhatsApp?: { owner: WhatsAppOwner; deliverySecret: string };
  clock?: ClockClient;
  paRepos?: string[];
  /** The supervisor's status file (init writes it). Absent = /healthz reports the hub alone. */
  statusFile?: string;
  /**
   * Who a Bot ships as, read from its Eve project by `host/bot-seed.ts`.
   * Seeded into an empty profile once, never over one the box already has.
   */
  profileSeed?: ProfileSeedReader;
  /**
   * What a Bot's Eve project ships (`host/bot-template.ts`), for the half of
   * a template that lives in git rather than on the volume. Absent means a
   * template exports what the box holds and nothing else, which is right for
   * a hub with no Eve projects beside it.
   */
  templateSource?: TemplateSourceReader;
  /**
   * How a Bot's setup is rewritten for a stranger: a POST to that Bot's own
   * Eve. Absent uses the same Eve URL and secret the proxy does; `null` is a
   * hub whose exports are never generic, which is what the tests want by
   * default so that none of them reaches a model.
   */
  templateGeneric?: AskEveFn | null;
  /** `false` claims every screen at boot and never releases one. */
  screens?: false;
  /** How long a screen may go unused before it is released. */
  screenIdleMs?: number;
  /** How often idle screens are looked for. */
  screenSweepMs?: number;
  /**
   * Wake a sleeping Bot and wait for its Eve to answer (`host/wake.ts`).
   * Absent means every Bot's Eve is already running, which is what a dev box
   * and the tests assume.
   */
  wake?: (botId: string, display: number) => Promise<void>;
  /** True while this Bot is awake and working; its screen is not swept. */
  botBusy?: (botId: string) => boolean;
  /**
   * True while any Bot is awake and working, for `/healthz`. The clock
   * outside the Machine (`apps/clock`) reads it to decide whether to keep
   * holding the Machine up, so it is the same question as `botBusy` asked of
   * the whole box rather than of one screen.
   */
  busy?: () => boolean;
}

export interface Hub {
  server: Server;
  wss: WebSocketServer;
  auth: AuthRegistry;
  bots: BotRegistry;
  provision: ProvisionService;
  coding: CodingService;
  connectors: ConnectorRegistry;
  conversations: ConversationRegistry;
  /** Mints and verifies the per-turn conversation binding the ingress hands to Eve. */
  turns: TurnService;
  router: ConnectRouter;
  /** Mounts the stored roster (or provisions "main") and claims windows. */
  start: () => Promise<void>;
  close: () => Promise<void>;
}

/** One generation on the Bot's own model, and not a turn: seconds, not minutes. */
const TEMPLATE_REWRITE_TIMEOUT_MS = 60_000;

export function createHub(opts: HubOptions): Hub {
  // Before the roster: every Bot's voice speaks into a conversation, so the
  // store has to exist before a Bot can be mounted over it.
  const conversations = new ConversationRegistry(opts.conversationStore, opts.messageLog);
  // A screen is claimed by being used and released when it goes quiet, so a
  // Bot nobody is talking to costs no Xvfb and no Chromium. `screenOnDemand`
  // is where "used" is defined, and it wraps the desk under both the model's
  // `computer` tool and every human seat RPC, so neither path can forget.
  // `screens: false` keeps the old behaviour (claim everything at boot).
  const screens: ScreenKeeper | undefined =
    opts.screens === false
      ? undefined
      : new ScreenKeeper(opts.windows, {
          idleMs: opts.screenIdleMs,
          isBusy: (display: number): boolean => {
            try {
              const bot = bots.byDisplay(display);
              // A human at the screen, or a Bot in the middle of a turn: the
              // second matters because a Bot doing half an hour of shell work
              // touches no X call, and losing its browser and its open tabs
              // mid-task is the sweep working against the work.
              return bot.seat.getState() !== "AGENT" || opts.botBusy?.(bot.id) === true;
            } catch {
              // No Bot on that display any more: nothing to protect.
              return false;
            }
          },
          onEvent: (line) => console.log(`computer ${line}`),
        });
  const deskFactory = screens
    ? (display: number): Desk =>
        screenOnDemand(opts.deskFactory(display), () => screens.use(display))
    : opts.deskFactory;
  const bots: BotRegistry = new BotRegistry(
    deskFactory,
    opts.store.load(),
    opts.policy,
    conversations,
  );
  const provision = new ProvisionService(
    bots,
    opts.windows,
    opts.store,
    conversations,
    opts.profileSeed,
    screens,
  );
  const auth = new AuthRegistry({
    agentTokens: () => bots.tokenEntries(),
    pixels: opts.pixels,
    principals: opts.principalStore,
    setupCode: opts.setupCode,
  });
  const router = new ConnectRouter(auth);
  const connectors = new ConnectorRegistry(opts.connectorStore);
  // An Eve turn can outlive a hub restart. Its original deadline still applies.
  const turns = new TurnService(undefined, opts.turnStorePath);
  const inbound = new InboundService(opts.inboundStorePath);
  const assistant = new AssistantState(opts.assistantStorePath);
  // A client of the runner, not a runtime: the work happens off this box.
  // Unconfigured (no CURSOR_API_KEY) is a hub whose coding RPCs answer
  // DAEMON_DOWN, exactly as the WhatsApp ones do without a bridge.
  const coding =
    opts.codingFactory?.(conversations) ??
    new CodingService(conversations, undefined, undefined, opts.codingIntents, opts.clock);

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

  /**
   * Rewrite this Bot's setup for a stranger, by asking the Bot.
   *
   * The same loopback door the connector ingress uses: that Bot's own Eve,
   * the hub's secret, and a wake first because a Bot nobody is talking to has
   * no process at all. It is `apps/eve/lib/channels/template.ts` on the other
   * end, and it answers with a rewritten document rather than starting a
   * turn, so nothing here hands the five tools a document to read.
   */
  const askEveForGeneric: AskEveFn = async (botId, template) => {
    const bot = bots.byId(botId);
    const url = eveUrl(bot.id, bot.display);
    if (!url) {
      throw new Error("this Bot has no Eve");
    }
    await opts.wake?.(bot.id, bot.display);
    const res = await fetch(`${url}/eve/v1/template/generic`, {
      body: JSON.stringify({ template }),
      headers: {
        "content-type": "application/json",
        ...(eveSecret ? { [EVE_HUB_SECRET_HEADER]: eveSecret } : {}),
      },
      method: "POST",
      // A document, not a turn: long enough for one generation and no longer.
      signal: AbortSignal.timeout(TEMPLATE_REWRITE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `Eve answered ${res.status}`);
    }
    return await res.json();
  };

  const routines =
    opts.clock && opts.paOwner
      ? new RoutineService({
          path: opts.routineStorePath,
          clock: opts.clock,
          notify: async (_bot, key, text) => {
            await inbound.publish(key, opts.paOwner!, text, opts.clock!);
          },
          run: async (routine, key) => {
            const owner = opts.paOwner!;
            const bot = bots.byId(routine.bot);
            await opts.wake?.(bot.id, bot.display);
            const conversation = conversations.resolve(bot.id, { kind: "whatsapp", ...owner }, [
              { bot: bot.id, kind: "bot" },
              { kind: "human", ref: owner.jid },
            ]);
            const turn = turns.mint({ bot: bot.id, conversation_id: conversation.id, owner });
            const message = `Scheduled owner routine ${routine.id} (revision ${routine.revision}):\n${routine.prompt}`;
            conversations.append(
              conversation.id,
              { kind: "human", ref: `routine:${routine.id}` },
              { kind: "human", text: message },
              { turn_id: turn.id },
            );
            const body = Buffer.from(
              JSON.stringify({
                acct: owner.acct,
                token: owner.jid,
                sender: owner.jid,
                senderName: "Scheduled routine",
                surface: "dm",
                message,
                messageId: key,
              }),
            );
            const result = await inbound.execute(`routine:${key}`, body, () =>
              runEveTurn({
                url: `${eveUrl(bot.id, bot.display)}/eve/v1/whatsapp/message`,
                secret: eveSecret,
                body,
                bot: bot.id,
                turn: turn.id,
                conversation: conversation.id,
                conversations,
                turns,
              }),
            );
            if (result.status !== 200) throw new Error("routine execution failed");
            const text = (JSON.parse(result.body) as { reply: string }).reply;
            if (text.trim())
              await inbound.publish(`routine:${key}:result`, owner, text, opts.clock!);
          },
        })
      : undefined;

  registerAgent(router, {
    bots,
    conversations,
    turns,
    coding,
    paOwner: opts.paOwner,
    routines,
    assistant,
    paRepos: opts.paRepos,
    wake: opts.wake,
  });
  registerSeat(router, {
    assistant,
    auth,
    bots,
    coding,
    conversations,
    provision,
    templates: new BotTemplateService(
      opts.templateSource,
      opts.templateGeneric === undefined ? askEveForGeneric : (opts.templateGeneric ?? undefined),
    ),
    vncUrl: opts.vncUrl,
    wake: opts.wake,
  });
  registerWhatsApp(router, { bots, bridge: opts.bridge, connectors, shared: opts.sharedWhatsApp });

  router.extra("GET", "/spec", "public", async () => loadSpecJson());
  // Honest health: the supervisor's view of desk, Eve and bridge beside the
  // hub's own. Always 200 while the hub answers, so a crash-looping Eve does
  // not make the platform restart the whole Machine; `ok` and `children`
  // carry the detail for the owner page and for a person reading it.
  router.extra("GET", "/healthz", "public", async () =>
    readHealth(opts.statusFile, Date.now(), opts.busy),
  );
  // bot.roster equivalent: ids, screens and profiles, never tokens. Cold on
  // the edge, and one box read per Bot for the profile, so it is the call a
  // client makes when the roster changes rather than the one it polls.
  router.extra("GET", "/roster", "seat", async () => ({
    bots: await Promise.all(
      bots.all().map(async (b) => ({
        display: b.display,
        id: b.id,
        profile: await b.state.profile(),
        state: b.seat.getState(),
      })),
    ),
  }));

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
      // Before the Connect router: one origin and one credential for the
      // clients: Eve's own protocol, gated by the seat token.
      if (isEvePath(url.pathname)) {
        await handleEveProxy(req, res, {
          auth,
          bots,
          cors: corsHeaders(),
          eveSecret,
          eveUrl,
          wake: opts.wake,
        });
        return;
      }
      // The other door: a connector secret, not a seat. Same Eve, same hub secret.
      if (isConnectorPath(url.pathname)) {
        await handleConnectorIngress(req, res, {
          inbound,
          paOwner: opts.bridge && opts.clock ? opts.paOwner : undefined,
          clock: opts.clock,
          bots,
          connectors,
          conversations,
          cors: corsHeaders(),
          eveSecret,
          eveUrl,
          turns,
          wake: opts.wake,
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
    // A human opening a screen is using it: the window comes up before the
    // socket is dialled, and watching it keeps it up. Without this a viewer
    // would get a refused connection on a sleeping Bot's display.
    use: screens ? (display) => screens.use(display) : undefined,
  });

  // Release what nobody has touched. A minute is often enough to be timely
  // and rare enough to cost nothing; the keeper decides what is idle.
  let sweeper: NodeJS.Timeout | undefined;
  let routineTimer: NodeJS.Timeout | undefined;
  const delivery =
    opts.bridge && opts.paOwner
      ? setInterval(() => {
          void inbound
            .flush(async (acct, jid, text, key) => {
              if (
                acct !== opts.paOwner!.acct ||
                jid !== opts.paOwner!.jid ||
                !connectors
                  .list()
                  .some((row) => row.id === `whatsapp-${acct}` && row.kind === "whatsapp")
              ) {
                return { sent: false };
              }
              return opts.bridge!.send(acct, jid, text, key);
            }, opts.clock)
            .catch(() => {
              console.error("WhatsApp delivery state could not be persisted");
            });
        }, 2000)
      : undefined;
  delivery?.unref();
  const codingPoll = opts.clock
    ? setInterval(() => {
        void coding.poll(async (session, source) => {
          if (!source || !opts.paOwner) return;
          const conversation = conversations.byId(source);
          const { route } = conversation;
          if (
            route.kind !== "whatsapp" ||
            route.acct !== opts.paOwner.acct ||
            route.jid !== opts.paOwner.jid
          )
            return;
          const link = workLink("code", conversation.bot, session.conversation_id);
          const status = session.state === "complete" ? "Coding result ready" : "Coding stopped";
          await inbound.publish(
            `coding:${session.agent}`,
            opts.paOwner,
            `${status}: ${session.repo}\n${link}`,
            opts.clock!,
          );
        });
      }, 30_000)
    : undefined;
  codingPoll?.unref();

  return {
    auth,
    bots,
    coding,
    connectors,
    conversations,
    close: () =>
      new Promise((resolveClose) => {
        clearInterval(sweeper);
        clearInterval(routineTimer);
        clearInterval(delivery);
        clearInterval(codingPoll);
        wss.close();
        server.close(() => resolveClose());
      }),
    provision,
    router,
    server,
    start: async () => {
      await provision.start();
      if (routines) {
        routineTimer = setInterval(() => {
          void routines.tick().catch(() => console.error("routine wake publication is pending"));
        }, 10_000);
        routineTimer.unref();
      }
      if (screens) {
        sweeper = setInterval(() => {
          void screens.sweep();
        }, opts.screenSweepMs ?? 60_000);
        // The box must be able to suspend and the process must be able to
        // exit: a sweep is housekeeping, not a reason to stay alive.
        sweeper.unref();
      }
    },
    turns,
    wss,
  };
}
