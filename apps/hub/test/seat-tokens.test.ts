import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthRegistry } from "../src/handler/auth.ts";
import { FileSeatTokenStore, MemorySeatTokenStore } from "../src/service/provision.ts";
import { rpc, startHub } from "./helper.ts";

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
    const seatStore = new FileSeatTokenStore(join(tempDir(), "nested", "seats.json"));

    const first = await startHub({ seatStore });
    const token = await first.pair();
    await expect(rpc(first.url, "/computer.v1.Seat/Status", {}, token)).resolves.toBeTruthy();
    await first.close();

    // A brand-new hub process, same disk. Before this store the token died here.
    const second = await startHub({ seatStore: new FileSeatTokenStore(seatStore["path"]) });
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
    const first = await startHub({ seatStore: new FileSeatTokenStore(path) });
    await first.pair();
    await first.close();

    const second = await startHub({ seatStore: new FileSeatTokenStore(path) });
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
    new FileSeatTokenStore(path).save(["tok"]);
    const perms = (p: string) => statSync(p).mode.toString(8).slice(-3);
    expect(perms(path)).toBe("600");
    expect(perms(dir)).toBe("700");
  });

  it("round-trips, and only a missing file reads as unpaired", () => {
    const path = join(tempDir(), "seats.json");
    const store = new FileSeatTokenStore(path);
    expect(store.load()).toEqual([]);
    store.save(["a", "b"]);
    expect(new FileSeatTokenStore(path).load()).toEqual(["a", "b"]);
  });

  it("throws on a corrupt token file instead of silently unpairing every phone", () => {
    const dir = tempDir();
    const bad = (body: string, name: string): string => {
      const p = join(dir, name);
      writeFileSync(p, body);
      return p;
    };
    expect(() => new FileSeatTokenStore(bad("{oops", "a.json")).load()).toThrow(/JSON/);
    expect(() => new FileSeatTokenStore(bad('{"tokens":[]}', "b.json")).load()).toThrow(/array/);
    expect(() => new FileSeatTokenStore(bad("[1,2]", "c.json")).load()).toThrow(/strings/);
  });

  it("mints through the store, so a token is on disk before it is handed out", () => {
    const seats = new MemorySeatTokenStore();
    const auth = new AuthRegistry({ agentTokens: () => [], seats, setupCode: "s" });
    const token = auth.pair("s");
    expect(seats.load()).toContain(token);
    // A second registry over the same store starts already knowing it.
    expect(
      new AuthRegistry({ agentTokens: () => [], seats, setupCode: "s" }).hasSeatToken(token),
    ).toBe(true);
  });
});
