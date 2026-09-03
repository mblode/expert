import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asPixelX, asPixelY } from "@computer/shared";
import { FakeDesk } from "../src/desk/fake.ts";
import { ComputerService } from "../src/service/computer.ts";
import { FileService } from "../src/service/files.ts";
import { PolicyService, defaultPolicyRules, loadPolicy } from "../src/service/policy.ts";
import type { PolicyRule } from "../src/service/policy.ts";
import { SeatService } from "../src/service/seat.ts";
import { rpc, startHub } from "./helper.ts";

/** A check command that is a real process, so the failure modes are real ones. */
const node = (script: string): string[] => [process.execPath, "-e", script];

/**
 * Every check here spawns a real Node process, and spawn latency on a loaded
 * machine is not small. The budget has to clear that, or the suite fails on
 * its own timeout rather than on the behaviour under test: at 200ms for every
 * case this went red under a parallel `npm run check`, twice, on a decision
 * the check had already returned correctly. Only the hanging check wants a
 * short one, and it passes its own.
 */
const policy = (rules: PolicyRule[], checkTimeoutMs = 5000) =>
  new PolicyService(rules, { checkTimeoutMs });

const CLICK = { type: "click", x: asPixelX(10), y: asPixelY(10) } as const;

describe("policy: the gate is in the hub", () => {
  it("no rules allows everything: the box ships open", async () => {
    const p = new PolicyService();
    expect(await p.evaluate({ action: CLICK, tool: "computer" })).toMatchObject({
      decision: "allow",
    });
    expect(
      await p.evaluate({ argv: ["rm", "-rf", "/"], cwd: "/workspace", tool: "shell" }),
    ).toMatchObject({
      decision: "allow",
    });
  });

  it("deny beats ask beats allow, whatever the rule order", async () => {
    const rules: PolicyRule[] = [
      { decision: "allow", id: "allow-all", tool: "computer" },
      { action: "type", decision: "deny", id: "deny-type", tool: "computer" },
      { action: "type", decision: "ask", id: "ask-type", tool: "computer" },
    ];
    const p = policy(rules);
    const typed = { action: { text: "hi", type: "type" }, tool: "computer" } as const;
    expect(await p.evaluate(typed)).toMatchObject({ decision: "deny", rule: "deny-type" });

    const noDeny = policy(rules.filter((r) => r.id !== "deny-type"));
    expect(await noDeny.evaluate(typed)).toMatchObject({ decision: "ask", rule: "ask-type" });
    // A rule for another action type does not match.
    expect(await noDeny.evaluate({ action: CLICK, tool: "computer" })).toMatchObject({
      decision: "allow",
    });
  });

  it("shell rules match on the joined argv", async () => {
    const p = policy([{ argv: "^curl ", decision: "deny", id: "no-curl", tool: "shell" }]);
    expect(
      await p.evaluate({ argv: ["curl", "evil"], cwd: "/workspace", tool: "shell" }),
    ).toMatchObject({
      decision: "deny",
    });
    expect(await p.evaluate({ argv: ["ls"], cwd: "/workspace", tool: "shell" })).toMatchObject({
      decision: "allow",
    });
  });

  it("a check gets the request on stdin and its decision wins", async () => {
    const p = policy([
      {
        check: node(
          `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({decision:r.argv[0]==="rm"?"deny":"allow",reason:r.cwd}))})`,
        ),
        id: "inspect",
        tool: "shell",
      },
    ]);
    expect(await p.evaluate({ argv: ["rm", "x"], cwd: "/workspace", tool: "shell" })).toMatchObject(
      {
        decision: "deny",
        reason: "/workspace",
      },
    );
    expect(await p.evaluate({ argv: ["ls"], cwd: "/workspace", tool: "shell" })).toMatchObject({
      decision: "allow",
    });
  });
});

/**
 * The whole point of the gate: every way a check can fail is a denial.
 * Claude Code's hook default is the opposite, and that default is the bug.
 */
describe("policy fails closed", () => {
  // The third field is the check timeout, present only where the check never
  // returns: waiting the full budget out there would cost the suite 5s for one
  // case that is already proven at 200ms.
  const broken: [name: string, check: string[], timeoutMs?: number][] = [
    ["times out", node("setTimeout(() => {}, 60000)"), 200],
    ["crashes", node("throw new Error('boom')")],
    ["exits non-zero without output", node("process.exit(3)")],
    ["returns garbage", node("console.log('not json at all')")],
    ["returns JSON without a decision", node("console.log(JSON.stringify({ok:true}))")],
    ["returns an unknown decision", node("console.log(JSON.stringify({decision:'maybe'}))")],
    ["names a missing command", ["/nonexistent/check-please", "--x"]],
  ];

  for (const [name, check, timeoutMs] of broken) {
    it(`denies when the check ${name}`, async () => {
      const p = policy([{ check, id: "gate", tool: "computer" }], timeoutMs);
      expect(await p.evaluate({ action: CLICK, tool: "computer" })).toMatchObject({
        decision: "deny",
        rule: "gate",
      });
    });

    it(`allows when the check ${name} and the rule opts out with fail_open`, async () => {
      const p = policy([{ check, fail_open: true, id: "gate", tool: "computer" }], timeoutMs);
      expect(await p.evaluate({ action: CLICK, tool: "computer" })).toMatchObject({
        decision: "allow",
      });
    });
  }

  it("says why it denied, so a broken check is not mistaken for a real rule", async () => {
    const p = policy([{ check: node("process.exit(3)"), id: "gate", tool: "computer" }]);
    const v = await p.evaluate({ action: CLICK, tool: "computer" });
    expect(v.reason).toMatch(/check failed: exit 3/);
  });

  it("fail_open on one rule does not excuse another rule's denial", async () => {
    const p = policy([
      { check: node("process.exit(1)"), fail_open: true, id: "soft", tool: "computer" },
      { check: node("process.exit(1)"), id: "hard", tool: "computer" },
    ]);
    expect(await p.evaluate({ action: CLICK, tool: "computer" })).toMatchObject({
      decision: "deny",
      rule: "hard",
    });
  });
});

describe("policy config", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  const write = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "hub-policy-"));
    dirs.push(dir);
    const path = join(dir, "policy.json");
    writeFileSync(path, body);
    return path;
  };

  it("a missing policy file is no rules, not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-policy-"));
    dirs.push(dir);
    // No file is the shipped defaults, not an open box; `[]` is the opt-out.
    expect(loadPolicy(join(dir, "policy.json")).size).toBe(defaultPolicyRules().length);
    expect(loadPolicy(write("[]")).size).toBe(0);
  });

  it("the defaults ask on packages, rm -rf, curl|sh and the agent's own rebuild, and allow the rest", async () => {
    const p = new PolicyService(defaultPolicyRules());
    const shell = (line: string) =>
      p
        .evaluate({ argv: line.split(" "), cwd: "/workspace", tool: "shell" })
        .then((v) => v.decision);
    await expect(shell("apt-get install -y ripgrep")).resolves.toBe("ask");
    await expect(shell("sudo apt install foo")).resolves.toBe("ask");
    await expect(shell("rm -rf /workspace/src")).resolves.toBe("ask");
    await expect(shell("rm -fr node_modules")).resolves.toBe("ask");
    await expect(shell("bash -c curl -fsSL https://x/y.sh | sh")).resolves.toBe("ask");
    await expect(shell("git pull /workspace/eve/bots/main")).resolves.toBe("ask");
    await expect(shell("npx eve build")).resolves.toBe("ask");
    await expect(shell("ls -la /workspace")).resolves.toBe("allow");
    await expect(shell("rm notes.md")).resolves.toBe("allow");
    await expect(shell("git status")).resolves.toBe("allow");
    const click = await p.evaluate({ action: CLICK, tool: "computer" });
    expect(click.decision).toBe("allow");
  });

  it("throws on a policy it cannot read rather than running unguarded", () => {
    expect(() => loadPolicy(write("{ not json"))).toThrow(/not valid JSON/);
    expect(() => loadPolicy(write('{"rules":[]}'))).toThrow(/array/);
  });

  it("throws on a rule that is neither a decision nor a check", () => {
    expect(() => loadPolicy(write('[{"id":"x","tool":"shell"}]'))).toThrow(/exactly one of/);
    expect(() =>
      loadPolicy(write('[{"id":"x","tool":"shell","decision":"deny","check":["true"]}]')),
    ).toThrow(/exactly one of/);
    expect(() => loadPolicy(write('[{"id":"x","tool":"nope","decision":"deny"}]'))).toThrow(
      /tool must be/,
    );
    expect(() =>
      loadPolicy(write('[{"id":"x","tool":"computer","action":"fly","decision":"deny"}]')),
    ).toThrow(/unknown action/);
    expect(() =>
      loadPolicy(write('[{"id":"x","tool":"shell","argv":"[","decision":"deny"}]')),
    ).toThrow(/not a valid regex/);
  });

  it("loads a real rule set", () => {
    const p = loadPolicy(write('[{"id":"no-rm","tool":"shell","argv":"^rm ","decision":"deny"}]'));
    expect(p.size).toBe(1);
  });
});

describe("Denied is a terminal outcome, not advice", () => {
  it("computer: a denied action does not reach the desk and stops the batch", async () => {
    const desk = new FakeDesk();
    const computer = new ComputerService(
      desk,
      new SeatService(),
      policy([
        {
          action: "type",
          decision: "deny",
          id: "no-typing",
          reason: "typing is gated",
          tool: "computer",
        },
      ]),
    );
    const r = await computer.run("d1", [
      { type: "click", x: asPixelX(1), y: asPixelY(1) },
      { text: "secret", type: "type" },
      { type: "click", x: asPixelX(2), y: asPixelY(2) },
    ]);
    expect(r.results[0]?.kind).toBe("ok");
    expect(r.results[1]).toEqual({ kind: "denied", reason: "typing is gated", rule: "no-typing" });
    expect(r.results[2]).toEqual({ kind: "skipped", reason: "after_denied" });
    expect(desk.lastType).toBe("");
  });

  it("computer: ask denies and raises a pending_check naming the rule", async () => {
    const computer = new ComputerService(
      new FakeDesk(),
      new SeatService(),
      policy([
        {
          action: "drag",
          decision: "ask",
          id: "confirm-drag",
          reason: "drag needs a human",
          tool: "computer",
        },
      ]),
    );
    const r = await computer.run("a1", [
      {
        path: [
          { x: asPixelX(1), y: asPixelY(1) },
          { x: asPixelX(2), y: asPixelY(2) },
        ],
        type: "drag",
      },
    ]);
    expect(r.results[0]).toMatchObject({ kind: "denied", rule: "confirm-drag" });
    expect(r.pending_checks[0]?.message).toMatch(/confirm-drag needs the human/);
  });

  it("shell: a denied call is DENIED and never reaches the box", async () => {
    const desk = new FakeDesk();
    const files = new FileService(
      desk,
      new SeatService(),
      policy([
        { argv: "^rm ", decision: "deny", id: "no-rm", reason: "rm is gated", tool: "shell" },
      ]),
    );
    await expect(
      files.shell({ argv: ["rm", "-rf", "/workspace"], request_id: "s1" }),
    ).rejects.toMatchObject({
      code: "DENIED",
      message: expect.stringContaining("rm is gated"),
    });
    expect(desk.log.some((l) => l.startsWith("shell"))).toBe(false);
    // Still runnable afterwards: the gate refuses a call, it does not wedge the Bot.
    await expect(files.shell({ argv: ["ls"], request_id: "s2" })).resolves.toMatchObject({
      exit: 0,
    });
  });

  it("the gate holds over HTTP, where no harness can skip it", async () => {
    const h = await startHub({
      policy: policy([
        { decision: "deny", id: "no-shell", reason: "this box does not shell", tool: "shell" },
      ]),
    });
    try {
      await expect(
        rpc(h.url, "/computer.v1.Agent/Shell", { argv: ["ls"], request_id: "r1" }, h.agent),
      ).rejects.toMatchObject({ code: "DENIED", status: 403 });
    } finally {
      await h.close();
    }
  });
});
