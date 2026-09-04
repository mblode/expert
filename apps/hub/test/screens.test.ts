import { afterEach, describe, expect, it } from "vitest";
import { NoopWindowManager } from "../src/desk/windows.ts";
import { ScreenKeeper } from "../src/service/screens.ts";
import { FakeDesk } from "../src/desk/fake.ts";
import { screenOnDemand } from "../src/desk/lazy.ts";
import { rpc, startHub } from "./helper.ts";

type Opened = Awaited<ReturnType<typeof startHub>>;

/**
 * A screen is 430 MB of Xvfb, openbox, x11vnc and Chromium, and the guest has
 * 2 GB for eight of them. So a screen exists while it is being used and not
 * otherwise, and these are the two halves of that: what counts as using one,
 * and what is never taken away.
 */
describe("screens come up when used", () => {
  const opened: Opened[] = [];
  afterEach(async () => {
    while (opened.length) {
      await opened.pop()!.close();
    }
  });

  it("claims a registered screen on first use and once, not per action", async () => {
    const windows = new NoopWindowManager();
    const keeper = new ScreenKeeper(windows);
    keeper.register({ botId: "qa", display: 6, token: "bot_qa" });
    expect(keeper.isUp(6)).toBe(false);

    await Promise.all([keeper.use(6), keeper.use(6), keeper.use(6)]);
    expect(windows.started).toEqual([6]);
    expect(keeper.isUp(6)).toBe(true);

    await keeper.use(6);
    expect(windows.started).toEqual([6]);
  });

  it("leaves a display nobody registered alone", async () => {
    const windows = new NoopWindowManager();
    await new ScreenKeeper(windows).use(4);
    expect(windows.started).toEqual([]);
  });

  it("releases what has gone quiet, and never the primary", async () => {
    let now = 1000;
    const windows = new NoopWindowManager();
    const keeper = new ScreenKeeper(windows, { idleMs: 60_000, now: () => now });
    keeper.register({ botId: "main", display: 1, token: "bot_main" }, true);
    keeper.register({ botId: "qa", display: 6, token: "bot_qa" });
    await keeper.use(6);

    now += 30_000;
    await keeper.sweep();
    expect(windows.stopped).toEqual([]);

    now += 60_000;
    await keeper.sweep();
    expect(windows.stopped).toEqual([6]);
    expect(keeper.isUp(6)).toBe(false);
    // And it comes back the next time something touches it.
    await keeper.use(6);
    expect(windows.started).toEqual([6, 6]);
  });

  it("keeps a screen a human is at, however long they sit there", async () => {
    let now = 1000;
    const windows = new NoopWindowManager();
    const busy = new Set<number>([6]);
    const keeper = new ScreenKeeper(windows, {
      idleMs: 1,
      isBusy: (display) => busy.has(display),
      now: () => now,
    });
    keeper.register({ botId: "qa", display: 6, token: "bot_qa" });
    await keeper.use(6);

    now += 10_000;
    await keeper.sweep();
    expect(windows.stopped).toEqual([]);

    busy.delete(6);
    await keeper.sweep();
    expect(windows.stopped).toEqual([6]);
  });

  it("a stop that fails leaves the screen up rather than lying about it", async () => {
    const windows = new NoopWindowManager();
    windows.stopWindow = () => Promise.reject(new Error("stop-window 6 failed"));
    const keeper = new ScreenKeeper(windows, { idleMs: 0 });
    keeper.register({ botId: "qa", display: 6, token: "bot_qa" }, true);
    await keeper.sweep();
    expect(keeper.isUp(6)).toBe(true);
  });
});

describe("what counts as using a screen", () => {
  it("is the X calls, not the filesystem or a health probe", async () => {
    const desk = new FakeDesk({ display: 2 });
    let used = 0;
    const lazy = screenOnDemand(desk, async () => {
      used += 1;
    });

    await lazy.readFile("/workspace/notes.md").catch(() => undefined);
    await lazy.writeFile("/workspace/notes.md", "x");
    await lazy.shell(["true"], "/workspace", 5);
    await lazy.ping();
    lazy.getCursor();
    expect(used).toBe(0);

    await lazy.screenshot();
    await lazy.click(1, 1, "left");
    await lazy.type("hi");
    await lazy.clipboardGet();
    expect(used).toBe(4);
  });
});

describe("a Bot with nothing to do owns no screen", () => {
  const opened: Opened[] = [];
  afterEach(async () => {
    while (opened.length) {
      await opened.pop()!.close();
    }
  });

  it("boots with the primary screen only, and wakes another one on demand", async () => {
    const h = await startHub({
      bots: [
        { display: 1, id: "main", token: "agent-token-test" },
        { display: 6, id: "qa", token: "bot_qa" },
      ],
    });
    opened.push(h);
    // Seven Bots that nobody has messaged cost nothing at boot.
    expect(h.windows.started).toEqual([1]);

    await rpc(
      h.url,
      "/computer.v1.Agent/Computer",
      { actions: [{ type: "click", x: 1, y: 1 }], request_id: "r1" },
      "bot_qa",
    );
    expect(h.windows.started).toEqual([1, 6]);
    expect(h.desks.get(6)!.log).toContain("click left 1,1");
  });
});

describe("the box cannot be asked for more screens than it has memory for", () => {
  it("releases the least recently used screen to make room", async () => {
    let now = 1000;
    const windows = new NoopWindowManager();
    const keeper = new ScreenKeeper(windows, { maxUp: 2, now: () => now });
    keeper.register({ botId: "main", display: 1, token: "bot_main" }, true);
    keeper.register({ botId: "qa", display: 6, token: "bot_qa" });
    keeper.register({ botId: "seo", display: 7, token: "bot_seo" });

    await keeper.use(6);
    expect(keeper.isUp(6)).toBe(true);
    now += 1000;
    await keeper.use(7);
    // The primary screen is never the victim, so QA's is.
    expect(windows.stopped).toEqual([6]);
    expect(keeper.isUp(1)).toBe(true);
    expect(keeper.isUp(6)).toBe(false);
    expect(keeper.isUp(7)).toBe(true);
  });

  it("claims anyway rather than refusing a Bot its own screen", async () => {
    const windows = new NoopWindowManager();
    // Both other screens are held by humans, so there is nothing to release.
    const keeper = new ScreenKeeper(windows, { isBusy: () => true, maxUp: 1 });
    keeper.register({ botId: "main", display: 1, token: "bot_main" }, true);
    keeper.register({ botId: "qa", display: 6, token: "bot_qa" });
    await keeper.use(6);
    expect(keeper.isUp(6)).toBe(true);
    expect(windows.stopped).toEqual([]);
  });

  it("does not drive a screen that is being torn down", async () => {
    let release: (() => void) | undefined;
    const windows = new NoopWindowManager();
    windows.stopWindow = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const keeper = new ScreenKeeper(windows, { idleMs: 0 });
    keeper.register({ botId: "qa", display: 6, token: "bot_qa" }, true);

    const sweeping = keeper.sweep();
    // Mid-teardown a request arrives. It must wait for the stop and then
    // claim a fresh window, not read the dying one as up.
    const using = keeper.use(6);
    release?.();
    await sweeping;
    await using;
    expect(windows.started).toEqual([6]);
    expect(keeper.isUp(6)).toBe(true);
  });
});

describe("a screen restored by the box at boot", () => {
  const opened: Opened[] = [];
  afterEach(async () => {
    while (opened.length) {
      await opened.pop()!.close();
    }
  });

  it("is released rather than left running unmanaged", async () => {
    const h = await startHub({
      bots: [
        { display: 1, id: "main", token: "agent-token-test" },
        { display: 6, id: "qa", token: "bot_qa" },
      ],
    });
    opened.push(h);
    // `desk-up` restores every window the box had claimed before the restart,
    // so the sleeping Bots' screens are taken down when the roster mounts.
    expect(h.windows.stopped).toEqual([6]);
  });
});
