import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthRegistry, GUEST_MAX_TTL_MS, ISSUED_MAX_TTL_MS } from "../src/handler/auth.ts";
import { FilePrincipalStore, MemoryPrincipalStore } from "../src/service/principals.ts";
import type { PrincipalRecord } from "../src/service/principals.ts";
import { rpc, startHub } from "./helper.ts";

const agentTokens = () => [["agent-token", "main"]] as [string, string][];

const registry = (): AuthRegistry =>
  new AuthRegistry({ agentTokens, principals: new MemoryPrincipalStore(), setupCode: "code" });

const STATUS = "/computer.v1.Seat/Status";
const POINTER = "/computer.v1.Seat/Pointer";
const CREATE_BOT = "/computer.v1.Seat/CreateBot";
const CLIPBOARD_GET = "/computer.v1.Seat/ClipboardGet";
const WHATSAPP_LINK = "/computer.v1.Seat/WhatsAppLink";
const ISSUE = "/computer.v1.Seat/Issue";

describe("every door resolves to one principal", () => {
  it("a bot token verifies as a bot principal, not as a seat", () => {
    const auth = registry();
    const verified = auth.verify("agent", "agent-token");
    expect(verified).toMatchObject({ botId: "main", kind: "agent" });
    expect(verified.principal).toMatchObject({ kind: "bot", role: "bot", subject: "main" });
    // The same token is not a seat: policies do not leak into each other.
    expect(() => auth.verify("seat", "agent-token", STATUS)).toThrow(/seat token required/);
  });

  it("a paired seat is an owner user with no subject, because Pair cannot know one", () => {
    const auth = registry();
    const token = auth.pair("code");
    expect(auth.principalFor(token)).toMatchObject({ kind: "user", role: "owner" });
    expect(auth.principalFor(token)?.subject).toBeUndefined();
  });
});

describe("roles are method sets", () => {
  it("an operator drives the box but cannot reshape it", () => {
    const auth = registry();
    const owner = auth.principalFor(auth.pair("code"))!;
    const op = auth.issue({ role: "operator", subject: "ada@example.com" }, owner);

    expect(auth.verify("seat", op.token, POINTER).principal?.subject).toBe("ada@example.com");
    expect(auth.verify("seat", op.token, STATUS).principal?.role).toBe("operator");
    for (const method of [CREATE_BOT, WHATSAPP_LINK, CLIPBOARD_GET, ISSUE]) {
      expect(() => auth.verify("seat", op.token, method)).toThrow(/cannot do that/);
    }
  });

  it("a viewer reads and never touches", () => {
    const auth = registry();
    const owner = auth.principalFor(auth.pair("code"))!;
    const viewer = auth.issue({ role: "viewer", subject: "grace" }, owner);

    expect(auth.verify("seat", viewer.token, STATUS).principal?.role).toBe("viewer");
    expect(() => auth.verify("seat", viewer.token, POINTER)).toThrow(/cannot do that/);
  });

  it("an owner reaches a method nobody thought to list", () => {
    const auth = registry();
    const token = auth.pair("code");
    // Owner is unrestricted on purpose: a Seat RPC added tomorrow works for
    // the box's owner and stays denied to every narrower role until listed.
    expect(auth.verify("seat", token, "/computer.v1.Seat/SomethingAddedLater").kind).toBe("seat");
  });
});

describe("issuing a seat", () => {
  it("an issuer may hand out working seats but never privilege", () => {
    const auth = registry();
    const owner = auth.principalFor(auth.pair("code"))!;
    // What the control plane holds instead of the setup code.
    const issuer = auth.issue({ label: "hello.expert", role: "issuer" }, owner);

    const seat = auth.issue({ role: "operator", subject: "ada" }, issuer);
    expect(seat.subject).toBe("ada");
    expect(() => auth.issue({ role: "owner" }, issuer)).toThrow(/may not issue the owner role/);
    expect(() => auth.issue({ role: "issuer" }, issuer)).toThrow(/may not issue the issuer role/);
  });

  it("a seat that is not an owner or an issuer cannot issue at all", () => {
    const auth = registry();
    const owner = auth.principalFor(auth.pair("code"))!;
    const op = auth.issue({ role: "operator" }, owner);
    expect(() => auth.issue({ role: "viewer" }, op)).toThrow(/only an owner or an issuer/);
  });

  it("bot and ingress are not seats", () => {
    const auth = registry();
    const owner = auth.principalFor(auth.pair("code"))!;
    expect(() => auth.issue({ role: "bot" }, owner)).toThrow(/not issued as a seat/);
    expect(() => auth.issue({ role: "ingress" }, owner)).toThrow(/not issued as a seat/);
  });

  it("expiry is capped and enforced on read", () => {
    const auth = registry();
    const now = Date.parse("2026-09-02T00:00:00.000Z");
    const owner = auth.principalFor(auth.pair("code"), now)!;
    const short = auth.issue({ role: "viewer", ttlMs: 60_000 }, owner, now);
    expect(auth.principalFor(short.token, now + 59_000)).toBeTruthy();
    expect(auth.principalFor(short.token, now + 61_000)).toBeUndefined();

    const greedy = auth.issue({ role: "viewer", ttlMs: ISSUED_MAX_TTL_MS * 10 }, owner, now);
    expect(Date.parse(greedy.expires_at!)).toBe(now + ISSUED_MAX_TTL_MS);
  });

  it("a guest gets its own ceiling and can never be unexpiring", () => {
    const auth = registry();
    const now = Date.parse("2026-09-02T00:00:00.000Z");
    const owner = auth.principalFor(auth.pair("code"), now)!;

    // The 30 day cap is for named people the owner meant to keep. A guest is
    // a stranger holding a link, so it is bounded by the link's own ceiling.
    const greedy = auth.issue({ display: 1, role: "guest", ttlMs: ISSUED_MAX_TTL_MS }, owner, now);
    expect(Date.parse(greedy.expires_at!)).toBe(now + GUEST_MAX_TTL_MS);

    // No ttl means no expiry for every other role. For a guest it is refused,
    // because a permanent guest is the hole the invite path just closed.
    expect(() => auth.issue({ display: 1, role: "guest" }, owner, now)).toThrow(/needs a ttl/);
    expect(auth.issue({ role: "viewer" }, owner, now).expires_at).toBeUndefined();
  });

  it("methods narrow a role and never widen it", () => {
    const auth = registry();
    const owner = auth.principalFor(auth.pair("code"))!;
    const issuer = auth.issue({ role: "issuer", subject: "hello.expert" }, owner);

    // The escalation this closes: an issuer may not hand out an owner, so it
    // asks for a role it may hand out and names a method that role does not
    // carry. CreateBot returns a bot token, and a bot token is shell on the box.
    const smuggled = auth.issue(
      { methods: [CREATE_BOT, STATUS], role: "operator", subject: "ada" },
      issuer,
    );
    expect(() => auth.verify("seat", smuggled.token, CREATE_BOT)).toThrow(/cannot do that/);
    expect(auth.verify("seat", smuggled.token, STATUS).principal?.role).toBe("operator");
    // Narrowing still works in the direction it was meant to: Pointer is an
    // operator method, and this grant did not ask for it.
    expect(() => auth.verify("seat", smuggled.token, POINTER)).toThrow(/cannot do that/);
  });

  it("an owner narrowed to a few methods stops being an owner at the other doors", () => {
    const auth = registry();
    const bare = auth.pair("code");
    const owner = auth.principalFor(bare)!;
    // What the plugins invite mints: owner, because no role carries CreateBot,
    // narrowed to the two RPCs the connection-file write needs.
    const scoped = auth.issue({ methods: [CREATE_BOT], role: "owner", ttlMs: 120_000 }, owner);

    expect(auth.verify("seat", scoped.token, CREATE_BOT).principal?.role).toBe("owner");
    expect(() => auth.verify("seat", scoped.token, WHATSAPP_LINK)).toThrow(/cannot do that/);
    // The Eve proxy, /roster and the pixel stream are HTTP routes, so no
    // allowlist names them. isOwner is the gate, and a narrowed owner is not one.
    expect(auth.isOwner(scoped.token)).toBe(false);
    expect(auth.isOwner(bare)).toBe(true);
  });
});

describe("what is already on disk keeps working", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  const file = (body: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), "hub-principals-"));
    dirs.push(dir);
    const path = join(dir, "seats.json");
    writeFileSync(path, JSON.stringify(body));
    return path;
  };

  it("reads both older shapes as the roles they meant", () => {
    // A bare string is the pre-scopes file, live on both Fly volumes. A
    // record with `kind: owner | guest` is the phase in between, where kind
    // carried the role.
    const path = file([
      "ancient-phone-token",
      { created_at: "2026-01-01T00:00:00.000Z", kind: "owner", token: "paired-token" },
      {
        created_at: "2026-01-01T00:00:00.000Z",
        display: 2,
        kind: "guest",
        methods: ["/computer.v1.Seat/Status"],
        token: "invite-token",
      },
    ]);
    const loaded = new FilePrincipalStore(path).load();
    expect(loaded.map((r) => [r.kind, r.role])).toEqual([
      ["user", "owner"],
      ["user", "owner"],
      ["user", "guest"],
    ]);
    const guest = loaded[2] as PrincipalRecord;
    expect(guest).toMatchObject({ display: 2, methods: ["/computer.v1.Seat/Status"] });

    const auth = new AuthRegistry({
      agentTokens,
      principals: new FilePrincipalStore(path),
      setupCode: "code",
    });
    expect(auth.isOwner("ancient-phone-token")).toBe(true);
    expect(auth.verify("seat", "invite-token", STATUS).principal?.role).toBe("guest");
    expect(() => auth.verify("seat", "invite-token", POINTER)).toThrow(/cannot do that/);
  });

  it("refuses a record it cannot place rather than guessing", () => {
    expect(() => new FilePrincipalStore(file([{ role: "wizard", token: "t" }])).load()).toThrow(
      /unknown role/,
    );
    expect(() =>
      new FilePrincipalStore(file([{ kind: "octopus", role: "owner", token: "t" }])).load(),
    ).toThrow(/unknown kind/);
  });
});

describe("issue over the wire", () => {
  it("the control plane issues a bound operator seat and never an owner", async () => {
    const h = await startHub({
      bots: [
        { display: 1, id: "main", token: "t1" },
        { display: 2, id: "night", token: "t2" },
      ],
    });
    try {
      const owner = await h.pair();
      const { token: issuer } = (await rpc(
        h.url,
        ISSUE,
        { label: "hello.expert", role: "issuer" },
        owner,
      )) as { token: string };

      const issued = (await rpc(
        h.url,
        ISSUE,
        { display: 2, role: "operator", subject: "ada@example.com", ttl_sec: 3600 },
        issuer,
      )) as { token: string; role: string; subject: string; expires_at: string };
      expect(issued).toMatchObject({ role: "operator", subject: "ada@example.com" });
      expect(issued.expires_at).not.toBe("");

      // Bound to its screen the same way a guest is: binding is the record's
      // display, not its role.
      const status = (await rpc(h.url, STATUS, {}, issued.token)) as {
        screens: { display: number }[];
      };
      expect(status.screens.map((s) => s.display)).toEqual([2]);
      await expect(rpc(h.url, STATUS, { display: 1 }, issued.token)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });

      // The containment rule, over the wire.
      await expect(rpc(h.url, ISSUE, { role: "owner" }, issuer)).rejects.toMatchObject({
        code: "DENIED",
      });
      await expect(rpc(h.url, ISSUE, { role: "viewer" }, issued.token)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
    } finally {
      await h.close();
    }
  });
});
