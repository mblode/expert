import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { connectorIdFor, normalisePhone } from "../src/handler/whatsapp.ts";
import { BridgeClient } from "../src/service/whatsapp.ts";
import { rpc, startHub } from "./helper.ts";

/**
 * A stand-in for apps/whatsapp-bridge: enough of the contract for the hub's
 * side to be tested end to end, with the requests it saw kept for assertions.
 */
async function fakeBridge(secret: string): Promise<{
  url: string;
  calls: { method: string; path: string; secret: string | undefined; body: unknown }[];
  accounts: Map<
    string,
    { bot: string; connector_id: string; connector_secret: string; phone?: string }
  >;
  close: () => Promise<void>;
}> {
  const calls: { method: string; path: string; secret: string | undefined; body: unknown }[] = [];
  const accounts = new Map<
    string,
    { bot: string; connector_id: string; connector_secret: string; phone?: string }
  >();
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const path = req.url ?? "";
      calls.push({
        body,
        method: req.method ?? "",
        path,
        secret: req.headers["x-bridge-secret"] as string,
      });
      if (req.headers["x-bridge-secret"] !== secret) {
        return json(res, 401, { error: "unauthorized" });
      }
      const m = /^\/accounts\/([^/]+)(?:\/(.+))?$/.exec(path);
      if (path === "/accounts" && req.method === "GET") {
        return json(res, 200, {
          accounts: [...accounts].map(([acct, a]) => ({
            acct,
            bot: a.bot,
            connector_id: a.connector_id,
            phone: a.phone ?? null,
            status: "unlinked",
          })),
        });
      }
      if (path === "/accounts" && req.method === "POST") {
        if (accounts.has(body.acct)) return json(res, 409, { error: "exists" });
        accounts.set(body.acct, body);
        return json(res, 201, { acct: body.acct });
      }
      if (!m || !accounts.has(m[1]!)) {
        return json(res, 404, { error: "no such account" });
      }
      const acct = m[1]!;
      if (req.method === "DELETE" && !m[2]) {
        accounts.delete(acct);
        return json(res, 200, { removed: true });
      }
      if (m[2] === "link") {
        return json(res, 200, {
          acct,
          age_ms: 12,
          pairing_code: body?.phone ? "ABCD-EFGH" : null,
          phone: body?.phone ?? null,
          qr: body?.phone ? null : "2@qr",
          status: "linking",
        });
      }
      if (m[2] === "groups") {
        return json(res, 200, {
          groups: [{ enabled: true, jid: "1@g.us", size: 3, subject: "Test" }],
        });
      }
      if (m[2] === "groups/join") {
        return json(res, 200, { jid: "2@g.us" });
      }
      if (m[2] === "config") {
        return json(res, 200, { config: body?.config ?? { trigger_mode: "mention" } });
      }
      return json(res, 404, { error: "no route" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        accounts,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
        url: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

describe("phone normalisation", () => {
  it("keeps digits only and refuses junk", () => {
    expect(normalisePhone("+61 400 000 000")).toBe("61400000000");
    expect(normalisePhone(undefined)).toBeUndefined();
    expect(normalisePhone("")).toBeUndefined();
    expect(() => normalisePhone("12")).toThrow(/6-15 digits/);
    expect(() => normalisePhone(123)).toThrow(/string/);
  });
});

describe("WhatsApp seat RPCs", () => {
  it("start creates the connector door and the bridge account, then links", async () => {
    const bridge = await fakeBridge("bridge-secret");
    const h = await startHub({
      bridge: new BridgeClient({ secret: "bridge-secret", url: bridge.url }),
    });
    try {
      const owner = await h.pair();
      const started = (await rpc(
        h.url,
        "/computer.v1.Seat/WhatsAppLink",
        { acct: "main", action: "start", phone: "+61 400 000 000" },
        owner,
      )) as { status: string; pairing_code: string | null };
      expect(started.status).toBe("linking");
      expect(started.pairing_code).toBe("ABCD-EFGH");

      // The bridge got a connector id and the secret the hub minted for it.
      const created = bridge.accounts.get("main")!;
      expect(created.connector_id).toBe(connectorIdFor("main"));
      const record = h.hub.connectors.byId(connectorIdFor("main"))!;
      expect(created.connector_secret).toBe(record.secret);
      expect(record.bot).toBe("main");
      expect(record.paths).toEqual(["/eve/v1/whatsapp/message"]);
      expect(created.phone).toBe("61400000000");

      // A second start on the same account does not mint again.
      await rpc(h.url, "/computer.v1.Seat/WhatsAppLink", { acct: "main", action: "start" }, owner);
      expect(h.hub.connectors.byId(connectorIdFor("main"))!.secret).toBe(record.secret);
      expect(
        bridge.calls.filter((c) => c.method === "POST" && c.path === "/accounts"),
      ).toHaveLength(1);

      const groups = (await rpc(
        h.url,
        "/computer.v1.Seat/WhatsAppGroups",
        { acct: "main" },
        owner,
      )) as { groups: unknown[] };
      expect(groups.groups).toHaveLength(1);
      await expect(
        rpc(h.url, "/computer.v1.Seat/WhatsAppJoinGroup", { acct: "main", invite: "abc" }, owner),
      ).resolves.toEqual({ jid: "2@g.us" });
      await expect(
        rpc(
          h.url,
          "/computer.v1.Seat/WhatsAppConfig",
          { acct: "main", config: { allowed_groups: ["1@g.us"] } },
          owner,
        ),
      ).resolves.toEqual({ config: { allowed_groups: ["1@g.us"] } });

      // Unlink closes the door with the number.
      await rpc(h.url, "/computer.v1.Seat/WhatsAppLink", { acct: "main", action: "unlink" }, owner);
      expect(h.hub.connectors.byId(connectorIdFor("main"))).toBeUndefined();
      expect(bridge.accounts.has("main")).toBe(false);
    } finally {
      await h.close();
      await bridge.close();
    }
  });

  it("is owner-only and DAEMON_DOWN without a bridge", async () => {
    const h = await startHub();
    try {
      const owner = await h.pair();
      await expect(
        rpc(h.url, "/computer.v1.Seat/WhatsAppAccounts", {}, owner),
      ).rejects.toMatchObject({ code: "DAEMON_DOWN" });
      const guest = h.hub.auth.mintGuest({ display: 1, ttlMs: 60_000 });
      await expect(
        rpc(h.url, "/computer.v1.Seat/WhatsAppAccounts", {}, guest.token),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(
        rpc(h.url, "/computer.v1.Seat/WhatsAppLink", { acct: "Bad Id", action: "start" }, owner),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    } finally {
      await h.close();
    }
  });

  it("maps a bridge that refuses the hub's secret to DAEMON_DOWN", async () => {
    const bridge = await fakeBridge("right");
    const h = await startHub({ bridge: new BridgeClient({ secret: "wrong", url: bridge.url }) });
    try {
      const owner = await h.pair();
      await expect(
        rpc(h.url, "/computer.v1.Seat/WhatsAppAccounts", {}, owner),
      ).rejects.toMatchObject({ code: "DAEMON_DOWN" });
    } finally {
      await h.close();
      await bridge.close();
    }
  });
});
