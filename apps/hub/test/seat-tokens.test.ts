import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthRegistry } from "../src/handler/auth.ts";
import { FilePrincipalStore, MemoryPrincipalStore } from "../src/service/principals.ts";
import { rpc, startHub } from "./helper.ts";
import type { PrincipalRecord } from "../src/service/principals.ts";

const owner = (token: string): PrincipalRecord => ({
  created_at: "2026-09-02T00:00:00.000Z",
  kind: "user",
  role: "owner",
  token,
});

describe("paired seats survive a restart", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "hub-seats-"));
    dirs.push(dir);
    return dir;
  };

  it("a phone paired before a restart is still paired after it", async () => {
    const principalStore = new FilePrincipalStore(join(tempDir(), "nested", "seats.json"));

    const first = await startHub({ principalStore });
    const token = await first.pair();
    await expect(rpc(first.url, "/computer.v1.Seat/Status", {}, token)).resolves.toBeTruthy();
    await first.close();

    // A brand-new hub process, same disk. Before this store the token died here.
    const second = await startHub({
      principalStore: new FilePrincipalStore(principalStore["path"]),
    });
    try {
      await expect(rpc(second.url, "/computer.v1.Seat/Status", {}, token)).resolves.toMatchObject({
        state: "AGENT",
      });
    } finally {
      await second.close();
    }
  });

  it("an unpaired token is still refused after a restart", async () => {
    const path = join(tempDir(), "seats.json");
    const first = await startHub({ principalStore: new FilePrincipalStore(path) });
    await first.pair();
    await first.close();

    const second = await startHub({ principalStore: new FilePrincipalStore(path) });
    try {
      await expect(
        rpc(second.url, "/computer.v1.Seat/Status", {}, "not-a-real-token"),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    } finally {
      await second.close();
    }
  });

  it("writes the token file 0600 inside a 0700 dir", () => {
    const dir = join(tempDir(), "data");
    const path = join(dir, "seats.json");
    new FilePrincipalStore(path).save([owner("tok")]);
    const perms = (p: string) => statSync(p).mode.toString(8).slice(-3);
    expect(perms(path)).toBe("600");
    expect(perms(dir)).toBe("700");
  });

  it("round-trips, and only a missing file reads as unpaired", () => {
    const path = join(tempDir(), "seats.json");
    const store = new FilePrincipalStore(path);
    expect(store.load()).toEqual([]);
    store.save([owner("a"), owner("b")]);
    expect(new FilePrincipalStore(path).load()).toEqual([owner("a"), owner("b")]);
  });

  it("throws on a corrupt token file instead of silently unpairing every phone", () => {
    const dir = tempDir();
    const bad = (body: string, name: string): string => {
      const p = join(dir, name);
      writeFileSync(p, body);
      return p;
    };
    expect(() => new FilePrincipalStore(bad("{oops", "a.json")).load()).toThrow(/JSON/);
    expect(() => new FilePrincipalStore(bad('{"tokens":[]}', "b.json")).load()).toThrow(/array/);
    expect(() => new FilePrincipalStore(bad("[1,2]", "c.json")).load()).toThrow(/strings/);
  });

  it("mints through the store, so a token is on disk before it is handed out", () => {
    const principals = new MemoryPrincipalStore();
    const auth = new AuthRegistry({ agentTokens: () => [], principals, setupCode: "s" });
    const token = auth.pair("s");
    expect(principals.load().map((r) => r.token)).toContain(token);
    // A second registry over the same store starts already knowing it.
    expect(
      new AuthRegistry({ agentTokens: () => [], principals, setupCode: "s" }).hasSeatToken(token),
    ).toBe(true);
  });
});
