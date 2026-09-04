import { createHub } from "../src/app.ts";
import type { Hub } from "../src/app.ts";
import { FakeDesk } from "../src/desk/fake.ts";
import { NoopWindowManager } from "../src/desk/windows.ts";
import { MemoryBotStore } from "../src/service/provision.ts";
import { MemoryPrincipalStore } from "../src/service/principals.ts";
import type { PrincipalStore } from "../src/service/principals.ts";
import type { PolicyService } from "../src/service/policy.ts";
import type { BotConfig } from "../src/service/bots.ts";
import type { CodingService } from "../src/service/coding.ts";
import type { ConnectorStore } from "../src/service/connectors.ts";
import type {
  ConversationRegistry,
  ConversationStore,
  MessageLog,
} from "../src/service/conversations.ts";
import type { BridgeClient } from "../src/service/whatsapp.ts";
import type { GenericConfig } from "../src/service/template-generic.ts";

const SETUP_CODE = "setup-code-test";
const AGENT_TOKEN = "agent-token-test";

export interface StartedHub {
  hub: Hub;
  desk: FakeDesk;
  desks: Map<number, FakeDesk>;
  windows: NoopWindowManager;
  store: MemoryBotStore;
  principalStore: PrincipalStore;
  url: string;
  agent: string;
  setup: string;
  pair: () => Promise<string>;
  close: () => Promise<void>;
}

/**
 * Boots a hub on a MemoryBotStore. Default roster: one bot "main" on :1
 * with AGENT_TOKEN. Pass `bots` for a multi-Bot roster; each display gets
 * its own FakeDesk (or the one you provide in `desks`).
 */
export async function startHub(
  opts: {
    bots?: BotConfig[];
    desks?: Map<number, FakeDesk>;
    vncBasePort?: number;
    /** Pass one to survive a restart in-test; a fresh hub loads what it saved. */
    principalStore?: PrincipalStore;
    policy?: PolicyService;
    eveUrls?: Record<string, string>;
    eveSecret?: string;
    connectorStore?: ConnectorStore;
    conversationStore?: ConversationStore;
    messageLog?: MessageLog;
    bridge?: BridgeClient;
    codingFactory?: (conversations: ConversationRegistry) => CodingService;
    /** The template rewriter. Null by default: no test may reach a gateway. */
    templateGeneric?: GenericConfig | null;
  } = {},
): Promise<StartedHub> {
  const configs = opts.bots ?? [{ display: 1, id: "main", token: AGENT_TOKEN }];
  const desks = opts.desks ?? new Map<number, FakeDesk>();
  const windows = new NoopWindowManager();
  const store = new MemoryBotStore();
  store.save(configs);
  const principalStore = opts.principalStore ?? new MemoryPrincipalStore();
  const hub = createHub({
    deskFactory: (display) => {
      const existing = desks.get(display);
      if (existing) return existing;
      const desk = new FakeDesk({ display });
      desks.set(display, desk);
      return desk;
    },
    bridge: opts.bridge,
    codingFactory: opts.codingFactory,
    connectorStore: opts.connectorStore,
    conversationStore: opts.conversationStore,
    messageLog: opts.messageLog,
    eveSecret: opts.eveSecret,
    eveUrls: opts.eveUrls,
    policy: opts.policy,
    principalStore,
    setupCode: SETUP_CODE,
    store,
    templateGeneric: opts.templateGeneric ?? null,
    vncBasePort: opts.vncBasePort,
    vncUrl: "http://127.0.0.1/vnc/index.html?view_only=1",
    windows,
  });
  await hub.start();
  await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const addr = hub.server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("no addr");
  }
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    agent: AGENT_TOKEN,
    close: () => hub.close(),
    desk: desks.get(1)!,
    desks,
    hub,
    pair: async () => {
      const r = await rpc(url, "/computer.v1.Seat/Pair", { code: SETUP_CODE });
      return (r as { token: string }).token;
    },
    principalStore,
    setup: SETUP_CODE,
    store,
    url,
    windows,
  };
}

export async function rpc(
  url: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<unknown> {
  const res = await fetch(`${url}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "connect-protocol-version": "1",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    method: "POST",
  });
  const json = await res.json();
  if (!res.ok) {
    const err = json as { error?: { code?: string; message?: string } };
    const e = new Error(err.error?.message ?? res.statusText) as Error & {
      code?: string;
      status: number;
    };
    e.code = err.error?.code;
    e.status = res.status;
    throw e;
  }
  return json;
}
