import { createHub, type BotOption, type Hub } from "../src/app.ts";
import { FakeDesk } from "../src/desk/fake.ts";

export async function startHub(
  desk = new FakeDesk(),
  extra: { bots?: BotOption[]; vncBasePort?: number } = {},
): Promise<{
  hub: Hub;
  desk: FakeDesk;
  url: string;
  agent: string;
  setup: string;
  pair: () => Promise<string>;
  close: () => Promise<void>;
}> {
  const setup = "setup-code-test";
  const agent = "agent-token-test";
  const hub = createHub({
    desk,
    setupCode: setup,
    agentToken: extra.bots ? undefined : agent,
    bots: extra.bots,
    vncBasePort: extra.vncBasePort,
    vncUrl: "http://127.0.0.1/vnc/index.html?view_only=1",
  });
  await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const addr = hub.server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    hub,
    desk,
    url,
    agent,
    setup,
    pair: async () => {
      const r = await rpc(url, "/computer.v1.Seat/Pair", { code: setup });
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
