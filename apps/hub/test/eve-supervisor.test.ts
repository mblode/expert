import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBotStore } from "../src/service/provision.ts";
import { ensureEveSecret, ensureRoster, ensureRosterAt } from "../src/host/ensure-roster.ts";
import { MAX_DISPLAYS } from "@computer/shared";
import {
  DEFAULT_EVE_OVERLAY,
  eveChildEnv,
  evePortForDisplay,
  eveProjectIds,
  planEveLaunches,
  resolveEveBotsRoot,
  superviseEves,
} from "../src/host/eve.ts";
import type { ChildSpec } from "../src/host/supervisor.ts";

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

  it("lists the Bots a build ships a project for, main first", () => {
    const botsRoot = tempDir();
    botProject(botsRoot, "qa");
    botProject(botsRoot, "main");
    botProject(botsRoot, "designer");
    mkdirSync(join(botsRoot, "notes"));
    expect(eveProjectIds(botsRoot)).toEqual(["main", "designer", "qa"]);
  });

  it("reads a standalone Eve project at the root as main", () => {
    const root = tempDir();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "vcmc-agent" }));
    mkdirSync(join(root, "agent"));
    expect(eveProjectIds(root)).toEqual(["main"]);
  });

  it("mints a row for every shipped project on the lowest free screen", () => {
    const path = join(tempDir(), "bots.json");
    const store = new FileBotStore(path);
    store.save([{ display: 1, id: "main", token: "bot_keep" }]);
    const roster = ensureRoster(store, ["main", "designer", "qa"]);
    expect(roster).toEqual([
      { display: 1, id: "main", token: "bot_keep" },
      { display: 2, id: "designer", token: expect.stringMatching(/^bot_/) as unknown as string },
      { display: 3, id: "qa", token: expect.stringMatching(/^bot_/) as unknown as string },
    ]);
    // Persisted, and stable: the second boot mints nothing.
    expect(ensureRoster(new FileBotStore(path), ["main", "designer", "qa"])).toEqual(roster);
  });

  it("keeps a Bot whose project is gone, screen and all", () => {
    const store = new FileBotStore(join(tempDir(), "bots.json"));
    store.save([
      { display: 1, id: "main", token: "bot_main" },
      { display: 2, id: "retired", token: "bot_retired" },
    ]);
    expect(ensureRoster(store, ["main"]).map((c) => c.id)).toEqual(["main", "retired"]);
  });

  it("refuses to put a ninth Bot on a box with eight screens", () => {
    const store = new FileBotStore(join(tempDir(), "bots.json"));
    const nine = Array.from({ length: 9 }, (_, i) => `bot-${i}`);
    const roster = ensureRoster(store, nine);
    expect(roster).toHaveLength(MAX_DISPLAYS);
    expect(roster.map((c) => c.display)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
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

  it("supervises every launch with a health probe, its own log and the caller's uid", () => {
    const specs: ChildSpec[] = [];
    superviseEves(
      { start: (spec) => specs.push(spec) },
      [
        { botId: "main", cwd: "/opt/eve/main", display: 1, port: 2000, token: "bot_main" },
        { botId: "night", cwd: "/opt/eve/night", display: 2, port: 2001, token: "bot_night" },
      ],
      {
        env: { PATH: "/bin" },
        eveSecret: "secret",
        exists: () => false,
        gid: 1000,
        hubUrl: "http://127.0.0.1:8080",
        logDir: "/var/log/computer",
        uid: 1000,
      },
    );
    expect(specs.map((s) => s.id)).toEqual(["eve-main", "eve-night"]);
    expect(specs[0]).toMatchObject({
      args: ["eve", "start", "--host", "127.0.0.1", "--port", "2000"],
      cmd: "npx",
      cwd: "/opt/eve/main",
      gid: 1000,
      healthUrl: "http://127.0.0.1:2000/eve/v1/health",
      log: "/var/log/computer/eve-main.log",
      uid: 1000,
    });
    expect(specs[1]?.env?.COMPUTER_BOT_TOKEN).toBe("bot_night");
    // A supervised child, not a detached one: no `oneShot`, so an Eve that
    // dies is restarted rather than left down until the box reboots.
    expect(specs[0]?.oneShot).toBeUndefined();
  });

  it("runs the built server itself when the Bot has been built", () => {
    const specs: ChildSpec[] = [];
    superviseEves(
      { start: (spec) => specs.push(spec) },
      [{ botId: "main", cwd: "/opt/eve/main", display: 1, port: 2000, token: "bot_main" }],
      {
        eveSecret: "secret",
        exists: (path) => path === "/opt/eve/main/.output/server/index.mjs",
        hubUrl: "http://127.0.0.1:8080",
        logDir: "/var/log/computer",
      },
    );
    // The CLI would spawn this same server and then sit on 367 MB watching it,
    // under an npm shim holding another 95. The guest has 2 GB for eight Bots.
    expect(specs[0]).toMatchObject({
      args: [".output/server/index.mjs"],
      cmd: process.execPath,
      cwd: "/opt/eve/main",
      // Still the same door: HOST and PORT come from the child environment.
      healthUrl: "http://127.0.0.1:2000/eve/v1/health",
    });
    expect(specs[0]?.env?.PORT).toBe("2000");
  });

  it("`npm run up` and the guest init share one Eve launcher", () => {
    const host = resolve(import.meta.dirname, "../src/host");
    for (const entry of ["init.ts", "eves.ts"]) {
      expect(readFileSync(join(host, entry), "utf-8"), entry).toContain("superviseEves(sup,");
    }
    // The detached spawn `superviseEves` replaced. It is gone, not shadowed.
    expect(existsSync(join(host, "start-eves.ts"))).toBe(false);
    expect(existsSync(join(host, "boot-eves.ts"))).toBe(false);
    expect(readFileSync(resolve(host, "../../../../scripts/computer.mjs"), "utf-8")).toContain(
      "src/host/eves.ts",
    );
  });

  it("init's repoRoot reaches the real repo, not a directory above the workspaces", () => {
    // It resolved one level short, to `<root>/apps`, and everything built on
    // it degraded in silence: `bridgeDir` became `apps/apps/whatsapp-bridge`,
    // whose `existsSync` guard reads a missing directory as "no bridge on
    // this image", so the WhatsApp bridge never started on the guest.
    const host = resolve(import.meta.dirname, "../src/host");
    const init = readFileSync(join(host, "init.ts"), "utf-8");
    const ups = /const repoRoot = resolve\(import\.meta\.dirname, "([^"]+)"\)/.exec(init)?.[1];
    expect(ups, "init.ts must derive repoRoot from its own directory").toBeDefined();
    const repoRoot = resolve(host, ups as string);

    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    expect(pkg.workspaces, `${repoRoot} is not the workspace root`).toBeTruthy();
    // The two paths that were silently wrong. Both must resolve to real dirs.
    expect(existsSync(join(repoRoot, "apps/whatsapp-bridge/package.json"))).toBe(true);
    expect(existsSync(join(repoRoot, "apps/eve/bots"))).toBe(true);
  });

  it("guest entrypoint hands off to the root init, which supervises desk, Eves, bridge and hub", () => {
    const script = readFileSync(
      resolve(import.meta.dirname, "../../../deploy/fly/guest-entrypoint.sh"),
      "utf-8",
    );
    expect(script).toContain("tsx src/host/init.ts");
    // The old shape: boot-eves then a runuser'd hub. Gone with the uid split.
    expect(script).not.toContain("boot-eves");
    expect(script).not.toContain("runuser");
    const init = readFileSync(resolve(import.meta.dirname, "../src/host/init.ts"), "utf-8");
    expect(init).toMatch(/desk-up[\s\S]*eve[\s\S]*whatsapp-bridge[\s\S]*--workspace=apps\/hub/);
    // Secrets reach children as env objects, never on argv, and the setup
    // code never reaches a box child at all.
    expect(init).toContain('"COMPUTER_SETUP_CODE", "WHATSAPP_BRIDGE_SECRET"');
    expect(init).not.toMatch(/args:\s*\[[^\]]*SECRET/);
    const dockerfile = readFileSync(
      resolve(import.meta.dirname, "../../../deploy/fly/Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("useradd --create-home --uid 1001 --shell /usr/sbin/nologin hub");
    expect(dockerfile).toContain('"hub ALL=(box) NOPASSWD: ALL"');
    expect(init).toContain("COMPUTER_RUN_AS: box.name");
  });

  it("guest entrypoint does not put secrets on any argv", () => {
    const script = readFileSync(
      resolve(import.meta.dirname, "../../../deploy/fly/guest-entrypoint.sh"),
      "utf-8",
    );
    const commands = script
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    // `env NAME=...` before a command puts the value in `ps`.
    expect(commands).not.toMatch(/\benv\s+[A-Z_]+=/);
    expect(commands).not.toContain('AI_GATEWAY_API_KEY="${AI_GATEWAY_API_KEY');
    expect(commands).not.toContain('COMPUTER_EVE_SECRET="$COMPUTER_EVE_SECRET"');
    expect(commands).not.toContain('COMPUTER_SETUP_CODE="$COMPUTER_SETUP_CODE"');
  });

  it("Vibey Fly config is a separate app and volume from Blode, same suspend size", () => {
    const blode = readFileSync(resolve(import.meta.dirname, "../../../fly.toml"), "utf-8");
    const vibey = readFileSync(resolve(import.meta.dirname, "../../../fly.vcmc.toml"), "utf-8");
    expect(blode).toMatch(/^app = "mblode-computer"$/m);
    expect(vibey).toMatch(/^app = "vcmc-computer"$/m);
    expect(vibey).not.toMatch(/app = "mblode-computer"/);
    expect(vibey).toContain('source = "vcmc_workspace"');
    expect(vibey).not.toContain('source = "computer_workspace"');
    expect(blode).toContain('source = "computer_workspace"');
    expect(vibey).toContain('primary_region = "syd"');
    expect(vibey).toContain('dockerfile = "deploy/fly/Dockerfile"');
    expect(vibey).toContain("/workspace/eve/bots");
    expect(vibey).not.toMatch(/volumes create/);
    expect(vibey).not.toMatch(/--size 20/);
    for (const guest of [blode, vibey]) {
      expect(guest).toMatch(/auto_stop_machines = "suspend"/);
      expect(guest).toMatch(/min_machines_running = 0/);
      expect(guest).toMatch(/auto_start_machines = true/);
      expect(guest).toMatch(/cpus = 2/);
      expect(guest).toMatch(/memory = "2gb"/);
      expect(guest).toMatch(/COMPUTER_IDLE_SUSPEND_SEC = "1200"/);
      expect(guest).not.toMatch(/auto_stop_machines = "off"/);
      expect(guest).not.toMatch(/min_machines_running = 1/);
      expect(guest).not.toMatch(/cpus = 4/);
      expect(guest).not.toMatch(/memory = "4gb"/);
    }
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
