import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthRegistry, GUEST_MAX_TTL_MS } from "../src/handler/auth.ts";
import { FileSeatTokenStore, MemorySeatTokenStore } from "../src/service/provision.ts";
import { rpc, startHub } from "./helper.ts";

const agentTokens = () => [["agent-token", "main"]] as [string, string][];

describe("seat scopes", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it("a legacy seats.json of bare strings loads as owner seats", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-scope-"));
    dirs.push(dir);
    const path = join(dir, "seats.json");
    writeFileSync(path, JSON.stringify(["old-phone-token"]));
    const auth = new AuthRegistry({
      agentTokens,
      seats: new FileSeatTokenStore(path),
      setupCode: "code",
    });
    expect(auth.isOwner("old-phone-token")).toBe(true);
    expect(auth.verify("seat", "old-phone-token", "/computer.v1.Seat/CreateBot").seat?.kind).toBe(
      "owner",
    );
  });

  it("a guest seat is bound to its methods and expires", () => {
    const auth = new AuthRegistry({
      agentTokens,
      seats: new MemorySeatTokenStore(),
      setupCode: "c",
    });
    // Real time: verify() reads the clock itself, so the guest must be live now.
    const now = Date.now();
    const guest = auth.mintGuest({ display: 2, label: "wa:invite", ttlMs: 60_000 }, now);
    expect(guest.kind).toBe("guest");
    expect(guest.display).toBe(2);
    expect(auth.verify("seat", guest.token, "/computer.v1.Seat/Pointer").seat?.kind).toBe("guest");
    expect(() => auth.verify("seat", guest.token, "/computer.v1.Seat/CreateBot")).toThrow(
      /cannot do that/,
    );
    expect(() => auth.verify("seat", guest.token, "/computer.v1.Seat/ClipboardGet")).toThrow(
      /cannot do that/,
    );
    expect(auth.isOwner(guest.token)).toBe(false);
    // Expired: unknown from then on, and gone from the store.
    expect(auth.seatFor(guest.token, now + 60_001)).toBeUndefined();
    expect(() => auth.verify("seat", guest.token, "/computer.v1.Seat/Status")).toThrow(
      /seat token required/,
    );
  });

  it("a guest ttl is capped and methods can only narrow", () => {
    const auth = new AuthRegistry({
      agentTokens,
      seats: new MemorySeatTokenStore(),
      setupCode: "c",
    });
    const now = Date.parse("2026-09-02T00:00:00Z");
    const guest = auth.mintGuest(
      {
        display: 1,
        methods: ["/computer.v1.Seat/Status", "/computer.v1.Seat/CreateBot"],
        ttlMs: 10 * GUEST_MAX_TTL_MS,
      },
      now,
    );
    expect(Date.parse(guest.expires_at!) - now).toBe(GUEST_MAX_TTL_MS);
    expect(guest.methods).toEqual(["/computer.v1.Seat/Status"]);
  });

  it("revoke drops a token and the sweep drops expired ones", () => {
    const store = new MemorySeatTokenStore();
    const auth = new AuthRegistry({ agentTokens, seats: store, setupCode: "c" });
    const now = Date.parse("2026-09-02T00:00:00Z");
    const owner = auth.pair("c", now);
    const guest = auth.mintGuest({ display: 1, ttlMs: 1000 }, now);
    expect(store.load()).toHaveLength(2);
    expect(auth.revoke(owner)).toBe(true);
    expect(auth.revoke(owner)).toBe(false);
    expect(auth.sweep(now + 2000)).toBe(1);
    expect(auth.seatFor(guest.token, now + 2000)).toBeUndefined();
    expect(store.load()).toHaveLength(0);
  });
});

describe("seat scopes over the wire", () => {
  it("Revoke ends the caller's own seat, and only an owner may revoke another", async () => {
    const h = await startHub({
      bots: [
        { display: 1, id: "main", token: "t1" },
        { display: 2, id: "night", token: "t2" },
      ],
    });
    try {
      const owner = await h.pair();
      const guest = h.hub.auth.mintGuest({ display: 2, ttlMs: 60_000 });

      // The guest sees only its screen, and is refused on any other.
      const status = (await rpc(h.url, "/computer.v1.Seat/Status", {}, guest.token)) as {
        screens: { display: number }[];
      };
      expect(status.screens.map((s) => s.display)).toEqual([2]);
      await expect(
        rpc(h.url, "/computer.v1.Seat/Status", { display: 1 }, guest.token),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(
        rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "x" }, guest.token),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      // Nor the thread, nor the roster.
      const eve = await fetch(`${h.url}/eve/v1/health`, {
        headers: { authorization: `Bearer ${guest.token}` },
      });
      expect(eve.status).toBe(401);
      const roster = await fetch(`${h.url}/roster`, {
        headers: { authorization: `Bearer ${guest.token}` },
      });
      expect(roster.status).toBe(401);

      // A guest cannot revoke the owner; an owner can revoke the guest.
      await expect(
        rpc(h.url, "/computer.v1.Seat/Revoke", { token: owner }, guest.token),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(
        rpc(h.url, "/computer.v1.Seat/Revoke", { token: guest.token }, owner),
      ).resolves.toEqual({ revoked: true });
      await expect(rpc(h.url, "/computer.v1.Seat/Status", {}, guest.token)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });

      // Sign-out: no argument, the caller's own token.
      await expect(rpc(h.url, "/computer.v1.Seat/Revoke", {}, owner)).resolves.toEqual({
        revoked: true,
      });
      await expect(rpc(h.url, "/computer.v1.Seat/Status", {}, owner)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
    } finally {
      await h.close();
    }
  });
});
