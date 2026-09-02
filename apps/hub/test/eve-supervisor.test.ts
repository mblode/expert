import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBotStore } from "../src/service/provision.ts";
import { ensureEveSecret, ensureRoster, ensureRosterAt } from "../src/host/ensure-roster.ts";
import {
  DEFAULT_EVE_OVERLAY,
  evePortForDisplay,
  planEveLaunches,
  resolveEveBotsRoot,
} from "../src/host/eve.ts";
import { eveChildEnv } from "../src/host/start-eves.ts";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) {
    rmSync(temps.pop()!, { recursive: true, force: true });
  }
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
        { display: 1, id: "main", token: "bot_main" },
        { display: 2, id: "night", token: "bot_night" },
        { display: 3, id: "ghost", token: "bot_ghost" },
      ],
      { botsRoot },
    );
    expect(launches).toEqual([
      { botId: "main", cwd: join(botsRoot, "main"), display: 1, port: 2000, token: "bot_main" },
      { botId: "night", cwd: join(botsRoot, "night"), display: 2, port: 2001, token: "bot_night" },
    ]);
    expect(evePortForDisplay(1)).toBe(2000);
    expect(evePortForDisplay(2)).toBe(2001);
  });

  it("launches roster main from a standalone Eve project at botsRoot", () => {
    const root = tempDir();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "vcmc-agent" }));
    mkdirSync(join(root, "agent"));
    const launches = planEveLaunches([{ display: 1, id: "main", token: "bot_main" }], {
      botsRoot: root,
    });
    expect(launches).toEqual([
      { botId: "main", cwd: root, display: 1, port: 2000, token: "bot_main" },
    ]);
  });

  it("prefers a populated volume overlay over COMPUTER_EVE_BOTS", () => {
    const overlay = "/workspace/eve/bots";
    const exists = (path: string) => path === join(overlay, "main", "package.json");
    expect(
      resolveEveBotsRoot({
        envBots: "/opt/computer/apps/eve/bots",
        exists,
        imageBots: "/opt/computer/apps/eve/bots",
        overlay,
      }),
    ).toBe(overlay);
  });

  it("uses a standalone overlay (vcmc-agent layout) when present", () => {
    const overlay = "/workspace/eve/bots";
    const exists = (path: string) =>
      path === join(overlay, "package.json") || path === join(overlay, "agent");
    expect(
      resolveEveBotsRoot({
        envBots: "/opt/computer/apps/eve/bots",
        exists,
        imageBots: "/opt/computer/apps/eve/bots",
        overlay,
      }),
    ).toBe(overlay);
  });

  it("falls back to COMPUTER_EVE_BOTS when the overlay is empty", () => {
    expect(
      resolveEveBotsRoot({
        envBots: "/opt/computer/apps/eve/bots",
        exists: () => false,
        imageBots: "/opt/image/bots",
        overlay: DEFAULT_EVE_OVERLAY,
      }),
    ).toBe("/opt/computer/apps/eve/bots");
  });

  it("starts zero processes when the roster has no Eve dirs", () => {
    expect(
      planEveLaunches([{ display: 1, id: "main", token: "t" }], { botsRoot: tempDir() }),
    ).toEqual([]);
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
    store.save([{ display: 1, id: "main", token: "bot_keep" }]);
    expect(ensureRoster(store)).toEqual([{ display: 1, id: "main", token: "bot_keep" }]);
  });

  it("refuses a roster row with a missing token", () => {
    const store = new FileBotStore(join(tempDir(), "bots.json"));
    store.save([{ display: 1, id: "main", token: "" }]);
    expect(() => ensureRoster(store)).toThrow(/no token/);
  });

  it("persists a hub→Eve secret on the volume and reuses it", () => {
    const path = join(tempDir(), "eve-secret");
    const a = ensureEveSecret(path);
    const b = ensureEveSecret(path);
    expect(a.length).toBeGreaterThan(10);
    expect(b).toBe(a);
    expect(readFileSync(path, "utf-8").trim()).toBe(a);
  });

  it("honours COMPUTER_EVE_SECRET when already set", () => {
    const path = join(tempDir(), "eve-secret");
    expect(ensureEveSecret(path, "from-env")).toBe("from-env");
    expect(readFileSync(path, "utf-8").trim()).toBe("from-env");
  });

  it("gives each Eve its own bot token and the shared hub secret", () => {
    const env = eveChildEnv(
      { botId: "main", cwd: "/opt/eve/main", display: 1, port: 2000, token: "bot_abc" },
      { env: { PATH: "/bin" }, eveSecret: "secret", hubUrl: "http://127.0.0.1:8080" },
    );
    expect(env.COMPUTER_BOT_TOKEN).toBe("bot_abc");
    expect(env.COMPUTER_URL).toBe("http://127.0.0.1:8080");
    expect(env.COMPUTER_EVE_SECRET).toBe("secret");
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe("2000");
  });

  it("guest entrypoint starts Eves from the roster then reads the secret file", () => {
    const script = readFileSync(
      resolve(import.meta.dirname, "../../../deploy/fly/guest-entrypoint.sh"),
      "utf-8",
    );
    expect(script).toContain("tsx src/host/boot-eves.ts");
    expect(script).toContain("/workspace/.computer/eve-secret");
    expect(script).toMatch(/desk-up[\s\S]*boot-eves[\s\S]*npm run start --workspace=apps\/hub/);
    expect(script).not.toContain('boot-eves.ts\n)"');
  });

  it("guest entrypoint does not put secrets on the runuser argv", () => {
    const script = readFileSync(
      resolve(import.meta.dirname, "../../../deploy/fly/guest-entrypoint.sh"),
      "utf-8",
    );
    const commands = script
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(script).toContain("--preserve-environment");
    // `env NAME=...` after runuser puts the value in `ps`.
    expect(commands).not.toMatch(/\benv\s+[A-Z_]+=/);
    expect(commands).not.toContain('AI_GATEWAY_API_KEY="${AI_GATEWAY_API_KEY');
    expect(commands).not.toContain('COMPUTER_EVE_SECRET="$COMPUTER_EVE_SECRET"');
    expect(commands).not.toContain('COMPUTER_SETUP_CODE="$COMPUTER_SETUP_CODE"');
  });

  it("vcmc Fly config is a separate app and volume from Matt's guest", () => {
    const matt = readFileSync(resolve(import.meta.dirname, "../../../fly.toml"), "utf-8");
    const vcmc = readFileSync(resolve(import.meta.dirname, "../../../fly.vcmc.toml"), "utf-8");
    expect(matt).toMatch(/^app = "mblode-computer"$/m);
    expect(vcmc).toMatch(/^app = "vcmc-computer"$/m);
    expect(vcmc).not.toMatch(/app = "mblode-computer"/);
    expect(vcmc).toContain('source = "vcmc_workspace"');
    expect(vcmc).not.toContain('source = "computer_workspace"');
    expect(vcmc).toContain('primary_region = "syd"');
    expect(vcmc).toContain('dockerfile = "deploy/fly/Dockerfile"');
    expect(vcmc).toContain("/workspace/eve/bots");
    expect(vcmc).not.toMatch(/volumes create/);
    expect(vcmc).not.toMatch(/--size 20/);
    expect(vcmc).toMatch(/auto_stop_machines = "suspend"/);
    expect(vcmc).toMatch(/min_machines_running = 0/);
    expect(vcmc).toMatch(/auto_start_machines = true/);
    expect(vcmc).toMatch(/cpus = 2/);
    expect(vcmc).toMatch(/memory = "2gb"/);
    expect(vcmc).not.toMatch(/cpus = 4/);
    expect(vcmc).not.toMatch(/memory = "4gb"/);
    expect(matt).toMatch(/auto_stop_machines = "off"/);
    expect(matt).toMatch(/min_machines_running = 1/);
  });

  it("eve bot apps declare just-bash so eve start can init the guest sandbox", () => {
    const bots = resolve(import.meta.dirname, "../../../apps/eve/bots");
    const ids = readdirSync(bots, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(ids).toContain("main");
    for (const id of ids) {
      const pkg = JSON.parse(readFileSync(join(bots, id, "package.json"), "utf-8")) as {
        dependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.["just-bash"], `${id} just-bash`).toMatch(/^\^?3\./);
      const sandbox = readFileSync(join(bots, id, "agent/sandbox.ts"), "utf-8");
      expect(sandbox).toMatch(/backend:\s*justbash\s*\(/);
      expect(sandbox).not.toMatch(/backend:\s*docker\s*\(/);
      expect(sandbox).not.toMatch(/backend:\s*vercel\s*\(/);
      const bash = readFileSync(join(bots, id, "agent/tools/bash.ts"), "utf-8");
      expect(bash, `${id} re-exports shared bash`).toMatch(/lib\/tools\/bash\.ts/);
      const shared = readFileSync(
        resolve(import.meta.dirname, "../../../apps/eve/lib/tools/bash.ts"),
        "utf-8",
      );
      expect(shared).toMatch(/disableTool\s*\(/);
    }
  });
});
