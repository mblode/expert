import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBotStore } from "../src/service/provision.ts";
import { ensureEveSecret, ensureRoster, ensureRosterAt } from "../src/host/ensure-roster.ts";
import { evePortForDisplay, planEveLaunches } from "../src/host/eve.ts";
import { eveChildEnv } from "../src/host/start-eves.ts";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eve-sup-"));
  temps.push(dir);
  return dir;
}

function botProject(root: string, id: string): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@computer/eve-${id}` }));
  return dir;
}

describe("eve supervisor: N Eves from the roster", () => {
  it("plans one launch per roster bot that has an Eve directory", () => {
    const botsRoot = tempDir();
    botProject(botsRoot, "main");
    botProject(botsRoot, "night");
    const launches = planEveLaunches(
      [
        { id: "main", display: 1, token: "bot_main" },
        { id: "night", display: 2, token: "bot_night" },
        { id: "ghost", display: 3, token: "bot_ghost" },
      ],
      { botsRoot },
    );
    expect(launches).toEqual([
      { botId: "main", display: 1, port: 2000, cwd: join(botsRoot, "main"), token: "bot_main" },
      { botId: "night", display: 2, port: 2001, cwd: join(botsRoot, "night"), token: "bot_night" },
    ]);
    expect(evePortForDisplay(1)).toBe(2000);
    expect(evePortForDisplay(2)).toBe(2001);
  });

  it("starts zero processes when the roster has no Eve dirs", () => {
    expect(planEveLaunches([{ id: "main", display: 1, token: "t" }], { botsRoot: tempDir() })).toEqual(
      [],
    );
  });

  it("mints main on an empty roster and persists the token", () => {
    const path = join(tempDir(), "bots.json");
    const first = ensureRosterAt(path);
    expect(first).toHaveLength(1);
    expect(first[0]!.id).toBe("main");
    expect(first[0]!.display).toBe(1);
    expect(first[0]!.token.startsWith("bot_")).toBe(true);
    const again = new FileBotStore(path).load();
    expect(again).toEqual(first);
  });

  it("does not mint over a roster row that already has a token", () => {
    const store = new FileBotStore(join(tempDir(), "bots.json"));
    store.save([{ id: "main", display: 1, token: "bot_keep" }]);
    expect(ensureRoster(store)).toEqual([{ id: "main", display: 1, token: "bot_keep" }]);
  });

  it("refuses a roster row with a missing token", () => {
    const store = new FileBotStore(join(tempDir(), "bots.json"));
    store.save([{ id: "main", display: 1, token: "" }]);
    expect(() => ensureRoster(store)).toThrow(/no token/);
  });

  it("persists a hub→Eve secret on the volume and reuses it", () => {
    const path = join(tempDir(), "eve-secret");
    const a = ensureEveSecret(path);
    const b = ensureEveSecret(path);
    expect(a.length).toBeGreaterThan(10);
    expect(b).toBe(a);
    expect(readFileSync(path, "utf8").trim()).toBe(a);
  });

  it("honours COMPUTER_EVE_SECRET when already set", () => {
    const path = join(tempDir(), "eve-secret");
    expect(ensureEveSecret(path, "from-env")).toBe("from-env");
    expect(readFileSync(path, "utf8").trim()).toBe("from-env");
  });

  it("gives each Eve its own bot token and the shared hub secret", () => {
    const env = eveChildEnv(
      { botId: "main", display: 1, port: 2000, cwd: "/opt/eve/main", token: "bot_abc" },
      { hubUrl: "http://127.0.0.1:8080", eveSecret: "secret", env: { PATH: "/bin" } },
    );
    expect(env.COMPUTER_BOT_TOKEN).toBe("bot_abc");
    expect(env.COMPUTER_URL).toBe("http://127.0.0.1:8080");
    expect(env.COMPUTER_EVE_SECRET).toBe("secret");
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe("2000");
  });

  it("guest entrypoint starts Eves from the roster then reads the secret file", () => {
    const script = readFileSync(resolve(import.meta.dirname, "../../../deploy/fly/guest-entrypoint.sh"), "utf8");
    expect(script).toContain("tsx src/host/boot-eves.ts");
    expect(script).toContain("/workspace/.computer/eve-secret");
    expect(script).toMatch(/desk-up[\s\S]*boot-eves[\s\S]*npm run start --workspace=apps\/hub/);
    expect(script).not.toContain("boot-eves.ts\n)\"");
  });
});
