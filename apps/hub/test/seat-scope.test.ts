import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatMethods } from "@computer/proto";
import { SEAT_INSTALLER_METHODS } from "@computer/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthRegistry,
  GUEST_MAX_TTL_MS,
  INSTALLER_MAX_TTL_MS,
  ISSUED_MAX_TTL_MS,
} from "../src/handler/auth.ts";
import { FilePrincipalStore, MemoryPrincipalStore } from "../src/service/principals.ts";
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
      principals: new FilePrincipalStore(path),
      setupCode: "code",
    });
    expect(auth.isOwner("old-phone-token")).toBe(true);
    expect(
      auth.verify("seat", "old-phone-token", "/computer.v1.Seat/CreateBot").principal?.role,
    ).toBe("owner");
  });

  it("a guest seat is bound to its methods and expires", () => {
    const auth = new AuthRegistry({
      agentTokens,
      principals: new MemoryPrincipalStore(),
      setupCode: "c",
    });
    // Real time: verify() reads the clock itself, so the guest must be live now.
    const now = Date.now();
    const guest = auth.mintGuest({ display: 2, label: "wa:invite", ttlMs: 60_000 }, now);
    expect(guest.role).toBe("guest");
    expect(guest.display).toBe(2);
    expect(auth.verify("seat", guest.token, "/computer.v1.Seat/Pointer").principal?.role).toBe(
      "guest",
    );
    expect(() => auth.verify("seat", guest.token, "/computer.v1.Seat/CreateBot")).toThrow(
      /cannot do that/,
    );
    expect(() => auth.verify("seat", guest.token, "/computer.v1.Seat/ClipboardGet")).toThrow(
      /cannot do that/,
    );
    expect(auth.isOwner(guest.token)).toBe(false);
    // Expired: unknown from then on, and gone from the store.
    expect(auth.principalFor(guest.token, now + 60_001)).toBeUndefined();
    expect(() => auth.verify("seat", guest.token, "/computer.v1.Seat/Status")).toThrow(
      /seat token required/,
    );
  });

  it("a guest ttl is capped and methods can only narrow", () => {
    const auth = new AuthRegistry({
      agentTokens,
      principals: new MemoryPrincipalStore(),
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
    const store = new MemoryPrincipalStore();
    const auth = new AuthRegistry({ agentTokens, principals: store, setupCode: "c" });
    const now = Date.parse("2026-09-02T00:00:00Z");
    const owner = auth.pair("c", now);
    const guest = auth.mintGuest({ display: 1, ttlMs: 1000 }, now);
    expect(store.load()).toHaveLength(2);
    expect(auth.revoke(owner)).toBe(true);
    expect(auth.revoke(owner)).toBe(false);
    expect(auth.sweep(now + 2000)).toBe(1);
    expect(auth.principalFor(guest.token, now + 2000)).toBeUndefined();
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

  it("an installer provisions and reaches nothing else, doors included", async () => {
    const h = await startHub();
    try {
      const owner = await h.pair();
      const installer = h.hub.auth.issue(
        { label: "hello.expert plugins invite", role: "installer", ttlMs: 2 * 60_000 },
        h.hub.auth.principalFor(owner)!,
      );

      // The one thing it is for: a throwaway Bot to write a file as, and its
      // removal. The token it gets back is a full agent token, which is why
      // this seat is two minutes long.
      const created = (await rpc(
        h.url,
        "/computer.v1.Seat/CreateBot",
        { id: "xw01" },
        installer.token,
      )) as { token: string };
      expect(created.token).toBeTruthy();
      await expect(
        rpc(h.url, "/computer.v1.Seat/DeleteBot", { id: "xw01" }, installer.token),
      ).resolves.toBeDefined();

      // Not the seat, not the thread, not the clipboard.
      for (const method of ["Status", "Pointer", "ClipboardGet", "Occurrences", "Issue"]) {
        await expect(
          rpc(h.url, `/computer.v1.Seat/${method}`, {}, installer.token),
        ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      }
      // Nor the owner-only HTTP routes, which is the whole reason this is a
      // role and not an owner narrowed by `methods`.
      for (const path of ["/eve/v1/health", "/roster"]) {
        const res = await fetch(`${h.url}${path}`, {
          headers: { authorization: `Bearer ${installer.token}` },
        });
        expect(res.status).toBe(401);
      }
    } finally {
      await h.close();
    }
  });
});

describe("the installer role", () => {
  const auth = (): AuthRegistry =>
    new AuthRegistry({ agentTokens, principals: new MemoryPrincipalStore(), setupCode: "c" });

  /** Every Seat method but the three, and Pair, which is unauthenticated. */
  const outside = Object.values(SeatMethods).filter(
    (method) =>
      method !== SeatMethods.Pair &&
      !(SEAT_INSTALLER_METHODS as readonly string[]).includes(method),
  );

  it("may create a Bot, delete it, and end itself, and is refused everything else", () => {
    const registry = auth();
    // Real time: verify() reads the clock itself, so the grant must be live now.
    const now = Date.now();
    const owner = registry.principalFor(registry.pair("c", now));
    const installer = registry.issue(
      { role: "installer", subject: "invite:abc", ttlMs: 2 * 60_000 },
      owner!,
      now,
    );
    expect(installer.role).toBe("installer");
    // The role is the definition. A `methods` list on the record would mean
    // the caller narrowing an owner by hand again, which is what this replaced.
    expect(installer.methods).toBeUndefined();

    for (const method of SEAT_INSTALLER_METHODS) {
      expect(registry.verify("seat", installer.token, method).principal?.role).toBe("installer");
    }
    expect(outside).toContain(SeatMethods.Status);
    expect(outside).toContain(SeatMethods.Issue);
    for (const method of outside) {
      expect(() => registry.verify("seat", installer.token, method)).toThrow(/cannot do that/);
    }
    // Neither the owner's HTTP doors: those are routes, so no allowlist names
    // them, and reading the role rather than the methods is what let a
    // hand-narrowed owner through them.
    expect(registry.isOwner(installer.token)).toBe(false);
    expect(registry.canViewPixels(installer.token)).toBe(false);
  });

  it("always expires, and inside ten minutes", () => {
    const registry = auth();
    const now = Date.parse("2026-09-03T00:00:00Z");
    const owner = registry.principalFor(registry.pair("c", now));
    expect(() => registry.issue({ role: "installer" }, owner!, now)).toThrow(
      /installer seat needs a ttl/,
    );
    const capped = registry.issue({ role: "installer", ttlMs: ISSUED_MAX_TTL_MS }, owner!, now);
    expect(Date.parse(capped.expires_at!) - now).toBe(INSTALLER_MAX_TTL_MS);
  });

  it("is a working role, so a control plane's issuer may hand one out", () => {
    const registry = auth();
    const now = Date.parse("2026-09-03T00:00:00Z");
    const owner = registry.principalFor(registry.pair("c", now));
    const issuer = registry.issue({ role: "issuer", subject: "control-plane" }, owner!, now);
    expect(registry.issue({ role: "installer", ttlMs: 2 * 60_000 }, issuer, now).role).toBe(
      "installer",
    );
    // What it still may not hand out is anything that mints principals.
    expect(() => registry.issue({ role: "owner" }, issuer, now)).toThrow(/may not issue the owner/);
    expect(() => registry.issue({ role: "issuer" }, issuer, now)).toThrow(
      /may not issue the issuer/,
    );
  });
});

describe("who may revoke whom", () => {
  const setup = (): {
    registry: AuthRegistry;
    owner: string;
    issuer: ReturnType<AuthRegistry["issue"]>;
  } => {
    const registry = new AuthRegistry({
      agentTokens,
      principals: new MemoryPrincipalStore(),
      setupCode: "c",
    });
    const owner = registry.pair("c");
    const issuer = registry.issue(
      { role: "issuer", subject: "control-plane" },
      registry.principalFor(owner)!,
    );
    return { issuer, owner, registry };
  };

  it("lets an issuer replace a grant it made, but not touch an owner or another issuer", () => {
    const { issuer, owner, registry } = setup();
    const guest = registry.mintGuest({ display: 1, ttlMs: 60_000 });
    // Replacing a link's seat is what `replaces` on the control plane does,
    // and it holds no owner to do it with any more.
    expect(registry.revokeFor(issuer, guest.token)).toBe(true);
    expect(() => registry.revokeFor(issuer, owner)).toThrow(/may not revoke owner/);
    const other = registry.issue(
      { role: "issuer", subject: "other" },
      registry.principalFor(owner)!,
    );
    expect(() => registry.revokeFor(issuer, other.token)).toThrow(/may not revoke issuer/);
    // And the owner is still there to be signed out normally.
    expect(registry.revokeFor(registry.principalFor(owner)!, owner)).toBe(true);
  });

  it("still lets any seat end itself and no narrower seat end another", () => {
    const { registry } = setup();
    const guest = registry.mintGuest({ display: 1, ttlMs: 60_000 });
    const other = registry.mintGuest({ display: 1, ttlMs: 60_000 });
    expect(() => registry.revokeFor(guest, other.token)).toThrow(/only an owner seat/);
    expect(registry.revokeFor(guest, guest.token)).toBe(true);
  });
});
