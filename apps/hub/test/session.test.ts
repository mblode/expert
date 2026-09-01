import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { AuthRegistry } from "../src/handler/auth.ts";
import { FileIdentityStore, MemoryIdentityStore, verifyHs256 } from "../src/service/identity.ts";
import { MemorySeatTokenStore } from "../src/service/provision.ts";
import { rpc, startHub } from "./helper.ts";

const SECRET = "test-jwt-secret-at-least-32-bytes-long!!";
const OTHER = "other-jwt-secret-at-least-32-bytes-long!";

async function sign(opts: {
  sub: string;
  email?: string;
  role?: string;
  exp?: string;
  secret?: string;
}): Promise<string> {
  return await new SignJWT({
    email: opts.email ?? `${opts.sub}@example.test`,
    role: opts.role ?? "authenticated",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(opts.sub)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(new TextEncoder().encode(opts.secret ?? SECRET));
}

describe("Seat.Session — JWT → seat token", () => {
  const opened: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (opened.length) await opened.pop()?.close();
  });

  it("exchanges a valid Supabase JWT for a seat and Status works", async () => {
    const h = await startHub({ identity: (jwt) => verifyHs256(jwt, SECRET) });
    opened.push(h);
    const jwt = await sign({ sub: "11111111-1111-4111-8111-111111111111" });
    const res = (await rpc(h.url, "/computer.v1.Seat/Session", {}, jwt)) as {
      token: string;
      vnc_url: string;
      status: { state: string; display: { width: number } };
    };
    expect(res.token.length).toBeGreaterThan(10);
    expect(res.vnc_url).toContain("view_only=1");
    expect(res.vnc_url).toContain(`token=${res.token}`);
    expect(res.status.display.width).toBe(1280);

    await expect(rpc(h.url, "/computer.v1.Seat/Status", {}, res.token)).resolves.toMatchObject({
      state: "AGENT",
    });
  });

  it("maps the same auth.users.id to the same seat token", async () => {
    const h = await startHub({ identity: (jwt) => verifyHs256(jwt, SECRET) });
    opened.push(h);
    const user = "22222222-2222-4222-8222-222222222222";
    const a = (await rpc(h.url, "/computer.v1.Seat/Session", {}, await sign({ sub: user }))) as {
      token: string;
    };
    const b = (await rpc(
      h.url,
      "/computer.v1.Seat/Session",
      {},
      await sign({ sub: user, email: "other@example.test" }),
    )) as { token: string };
    expect(a.token).toBe(b.token);

    const other = (await rpc(
      h.url,
      "/computer.v1.Seat/Session",
      {},
      await sign({ sub: "33333333-3333-4333-8333-333333333333" }),
    )) as { token: string };
    expect(other.token).not.toBe(a.token);
  });

  it("rejects a missing bearer, a bad signature, and an expired token", async () => {
    const h = await startHub({ identity: (jwt) => verifyHs256(jwt, SECRET) });
    opened.push(h);

    await expect(rpc(h.url, "/computer.v1.Seat/Session", {})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });

    const forged = await sign({ sub: "44444444-4444-4444-8444-444444444444", secret: OTHER });
    await expect(rpc(h.url, "/computer.v1.Seat/Session", {}, forged)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });

    const expired = await sign({
      sub: "55555555-5555-4555-8555-555555555555",
      exp: "0s",
    });
    await expect(rpc(h.url, "/computer.v1.Seat/Session", {}, expired)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });

    await expect(
      rpc(h.url, "/computer.v1.Seat/Status", {}, "not-a-seat-token"),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });

  it("Pair still works as the local-dev fallback beside Session", async () => {
    const h = await startHub({ identity: (jwt) => verifyHs256(jwt, SECRET) });
    opened.push(h);
    const token = await h.pair();
    await expect(rpc(h.url, "/computer.v1.Seat/Status", {}, token)).resolves.toMatchObject({
      state: "AGENT",
    });
  });

  it("Session is refused when email sign-in is not configured", async () => {
    const h = await startHub();
    opened.push(h);
    const jwt = await sign({ sub: "66666666-6666-4666-8666-666666666666" });
    await expect(rpc(h.url, "/computer.v1.Seat/Session", {}, jwt)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const token = await h.pair();
    await expect(rpc(h.url, "/computer.v1.Seat/Status", {}, token)).resolves.toBeTruthy();
  });

  it("a signed-in seat survives a restart via the identity store", async () => {
    const identities = new MemoryIdentityStore();
    const seats = new MemorySeatTokenStore();
    const first = await startHub({
      identity: (jwt) => verifyHs256(jwt, SECRET),
      identityStore: identities,
      seatStore: seats,
    });
    const jwt = await sign({ sub: "77777777-7777-4777-8777-777777777777" });
    const { token } = (await rpc(first.url, "/computer.v1.Seat/Session", {}, jwt)) as { token: string };
    await first.close();

    const second = await startHub({
      identity: (jwt) => verifyHs256(jwt, SECRET),
      identityStore: identities,
      seatStore: seats,
    });
    opened.push(second);
    await expect(rpc(second.url, "/computer.v1.Seat/Status", {}, token)).resolves.toMatchObject({
      state: "AGENT",
    });
    const again = (await rpc(second.url, "/computer.v1.Seat/Session", {}, jwt)) as { token: string };
    expect(again.token).toBe(token);
  });
});

describe("identity store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("writes identities 0600 inside a 0700 dir and round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-ident-"));
    dirs.push(dir);
    const path = join(dir, "nested", "identities.json");
    const store = new FileIdentityStore(path);
    expect(store.load()).toEqual({});
    store.save({ "user-a": "tok-a" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    expect(new FileIdentityStore(path).load()).toEqual({ "user-a": "tok-a" });
  });

  it("mints through both stores so a Session token is on disk before it is handed out", async () => {
    const seats = new MemorySeatTokenStore();
    const identities = new MemoryIdentityStore();
    const auth = new AuthRegistry({
      setupCode: "s",
      agentTokens: () => [],
      seats,
      identities,
      identity: (jwt) => verifyHs256(jwt, SECRET),
    });
    const jwt = await sign({ sub: "88888888-8888-4888-8888-888888888888" });
    const token = await auth.session(jwt);
    expect(seats.load()).toContain(token);
    expect(identities.load()["88888888-8888-4888-8888-888888888888"]).toBe(token);
  });
});
