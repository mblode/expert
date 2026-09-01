import { resolve } from "node:path";
import { createHub, type Hub } from "../src/app.ts";
import { FakeDesk } from "../src/desk/fake.ts";
import { NoopWindowManager } from "../src/desk/windows.ts";
import { MemoryBotStore, MemorySeatTokenStore, type SeatTokenStore } from "../src/service/provision.ts";
import type { PolicyService } from "../src/service/policy.ts";
import type { BotConfig } from "../src/service/bots.ts";

export const SETUP_CODE = "setup-code-test";
export const AGENT_TOKEN = "agent-token-test";

export type StartedHub = {
  hub: Hub;
  desk: FakeDesk;
  desks: Map<number, FakeDesk>;
  windows: NoopWindowManager;
  store: MemoryBotStore;
  seatStore: SeatTokenStore;
  url: string;
  agent: string;
  setup: string;
  pair: () => Promise<string>;
  close: () => Promise<void>;
};

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
    seatStore?: SeatTokenStore;
    policy?: PolicyService;
    /** Exported control panel to serve at `/`. Absent = no panel, as on a fresh clone. */
    webDir?: string;
  } = {},
): Promise<StartedHub> {
  const configs = opts.bots ?? [{ id: "main", display: 1, token: AGENT_TOKEN }];
  const desks = opts.desks ?? new Map<number, FakeDesk>();
  const windows = new NoopWindowManager();
  const store = new MemoryBotStore();
  store.save(configs);
  const seatStore = opts.seatStore ?? new MemorySeatTokenStore();
  const hub = createHub({
    setupCode: SETUP_CODE,
    deskFactory: (display) => {
      const existing = desks.get(display);
      if (existing) return existing;
      const desk = new FakeDesk({ display });
      desks.set(display, desk);
      return desk;
    },
    windows,
    store,
    seatStore,
    policy: opts.policy,
    // Absent means "no panel built", which is a real state and the default here
    // so the suite never depends on apps/web having been built.
    webDir: opts.webDir ?? resolve(import.meta.dirname, "no-such-panel"),
    vncBasePort: opts.vncBasePort,
    vncUrl: "http://127.0.0.1/vnc/index.html?view_only=1",
  });
  await hub.start();
  await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const addr = hub.server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    hub,
    desk: desks.get(1)!,
    desks,
    windows,
    store,
    seatStore,
    url,
    agent: AGENT_TOKEN,
    setup: SETUP_CODE,
    pair: async () => {
      const r = await rpc(url, "/computer.v1.Seat/Pair", { code: SETUP_CODE });
      return (r as { token: string }).token;
    },
    close: () => hub.close(),
  };
}

export async function rpc(
  url: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<unknown> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "connect-protocol-version": "1",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
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
