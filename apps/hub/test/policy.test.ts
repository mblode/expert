import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asPixelX, asPixelY } from "@computer/shared";
import { FakeDesk } from "../src/desk/fake.ts";
import { ComputerService } from "../src/service/computer.ts";
import { FileService } from "../src/service/files.ts";
import { PolicyService, loadPolicy, type PolicyRule } from "../src/service/policy.ts";
import { SeatService } from "../src/service/seat.ts";
import { rpc, startHub } from "./helper.ts";

/** A check command that is a real process, so the failure modes are real ones. */
const node = (script: string): string[] => [process.execPath, "-e", script];

/** Short timeout: the point is the deny, not the wait. */
const policy = (rules: PolicyRule[]) => new PolicyService(rules, { checkTimeoutMs: 200 });

const CLICK = { type: "click", x: asPixelX(10), y: asPixelY(10) } as const;

describe("policy: the gate is in the hub", () => {
  it("no rules allows everything — the box ships open", async () => {
    const p = new PolicyService();
    expect(await p.evaluate({ tool: "computer", action: CLICK })).toMatchObject({ decision: "allow" });
    expect(await p.evaluate({ tool: "shell", argv: ["rm", "-rf", "/"], cwd: "/workspace" })).toMatchObject({
      decision: "allow",
    });
  });

  it("deny beats ask beats allow, whatever the rule order", async () => {
    const rules: PolicyRule[] = [
      { id: "allow-all", tool: "computer", decision: "allow" },
      { id: "deny-type", tool: "computer", action: "type", decision: "deny" },
      { id: "ask-type", tool: "computer", action: "type", decision: "ask" },
    ];
    const p = policy(rules);
    const typed = { tool: "computer", action: { type: "type", text: "hi" } } as const;
    expect(await p.evaluate(typed)).toMatchObject({ decision: "deny", rule: "deny-type" });

    const noDeny = policy(rules.filter((r) => r.id !== "deny-type"));
    expect(await noDeny.evaluate(typed)).toMatchObject({ decision: "ask", rule: "ask-type" });
    // A rule for another action type does not match.
    expect(await noDeny.evaluate({ tool: "computer", action: CLICK })).toMatchObject({ decision: "allow" });
  });

  it("shell rules match on the joined argv", async () => {
    const p = policy([{ id: "no-curl", tool: "shell", argv: "^curl ", decision: "deny" }]);
    expect(await p.evaluate({ tool: "shell", argv: ["curl", "evil"], cwd: "/workspace" })).toMatchObject({
      decision: "deny",
    });
    expect(await p.evaluate({ tool: "shell", argv: ["ls"], cwd: "/workspace" })).toMatchObject({
      decision: "allow",
    });
  });

  it("a check gets the request on stdin and its decision wins", async () => {
    const p = policy([
      {
        id: "inspect",
        tool: "shell",
        check: node(
          `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({decision:r.argv[0]==="rm"?"deny":"allow",reason:r.cwd}))})`,
        ),
      },
    ]);
    expect(await p.evaluate({ tool: "shell", argv: ["rm", "x"], cwd: "/workspace" })).toMatchObject({
      decision: "deny",
      reason: "/workspace",
    });
    expect(await p.evaluate({ tool: "shell", argv: ["ls"], cwd: "/workspace" })).toMatchObject({
      decision: "allow",
    });
  });
});

/**
 * The whole point of the gate: every way a check can fail is a denial.
 * Claude Code's hook default is the opposite, and that default is the bug.
 */
describe("policy fails closed", () => {
  const broken: [name: string, check: string[]][] = [
    ["times out", node("setTimeout(() => {}, 60000)")],
    ["crashes", node("throw new Error('boom')")],
    ["exits non-zero without output", node("process.exit(3)")],
    ["returns garbage", node("console.log('not json at all')")],
    ["returns JSON without a decision", node("console.log(JSON.stringify({ok:true}))")],
    ["returns an unknown decision", node("console.log(JSON.stringify({decision:'maybe'}))")],
    ["names a missing command", ["/nonexistent/check-please", "--x"]],
  ];

  for (const [name, check] of broken) {
    it(`denies when the check ${name}`, async () => {
      const p = policy([{ id: "gate", tool: "computer", check }]);
      expect(await p.evaluate({ tool: "computer", action: CLICK })).toMatchObject({
        decision: "deny",
        rule: "gate",
      });
    });

    it(`allows when the check ${name} and the rule opts out with fail_open`, async () => {
      const p = policy([{ id: "gate", tool: "computer", check, fail_open: true }]);
      expect(await p.evaluate({ tool: "computer", action: CLICK })).toMatchObject({ decision: "allow" });
    });
  }

  it("says why it denied, so a broken check is not mistaken for a real rule", async () => {
    const p = policy([{ id: "gate", tool: "computer", check: node("process.exit(3)") }]);
    const v = await p.evaluate({ tool: "computer", action: CLICK });
    expect(v.reason).toMatch(/check failed: exit 3/);
  });

  it("fail_open on one rule does not excuse another rule's denial", async () => {
    const p = policy([
      { id: "soft", tool: "computer", check: node("process.exit(1)"), fail_open: true },
      { id: "hard", tool: "computer", check: node("process.exit(1)") },
    ]);
    expect(await p.evaluate({ tool: "computer", action: CLICK })).toMatchObject({
      decision: "deny",
      rule: "hard",
    });
  });
});

describe("policy config", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
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
    expect(loadPolicy(join(dir, "policy.json")).size).toBe(0);
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
    expect(() => loadPolicy(write('[{"id":"x","tool":"nope","decision":"deny"}]'))).toThrow(/tool must be/);
    expect(() => loadPolicy(write('[{"id":"x","tool":"computer","action":"fly","decision":"deny"}]'))).toThrow(
      /unknown action/,
    );
    expect(() => loadPolicy(write('[{"id":"x","tool":"shell","argv":"[","decision":"deny"}]'))).toThrow(
      /not a valid regex/,
    );
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
      policy([{ id: "no-typing", tool: "computer", action: "type", decision: "deny", reason: "typing is gated" }]),
    );
    const r = await computer.run("d1", [
      { type: "click", x: asPixelX(1), y: asPixelY(1) },
      { type: "type", text: "secret" },
      { type: "click", x: asPixelX(2), y: asPixelY(2) },
    ]);
    expect(r.results[0]?.kind).toBe("ok");
    expect(r.results[1]).toEqual({ kind: "denied", rule: "no-typing", reason: "typing is gated" });
    expect(r.results[2]).toEqual({ kind: "skipped", reason: "after_denied" });
    expect(desk.lastType).toBe("");
  });

  it("computer: ask denies and raises a pending_check naming the rule", async () => {
    const computer = new ComputerService(
      new FakeDesk(),
      new SeatService(),
      policy([{ id: "confirm-drag", tool: "computer", action: "drag", decision: "ask", reason: "drag needs a human" }]),
    );
    const r = await computer.run("a1", [
      { type: "drag", path: [{ x: asPixelX(1), y: asPixelY(1) }, { x: asPixelX(2), y: asPixelY(2) }] },
    ]);
    expect(r.results[0]).toMatchObject({ kind: "denied", rule: "confirm-drag" });
    expect(r.pending_checks[0]?.message).toMatch(/confirm-drag needs the human/);
  });

  it("shell: a denied call is DENIED and never reaches the box", async () => {
    const desk = new FakeDesk();
    const files = new FileService(
      desk,
      new SeatService(),
      policy([{ id: "no-rm", tool: "shell", argv: "^rm ", decision: "deny", reason: "rm is gated" }]),
    );
    await expect(files.shell({ request_id: "s1", argv: ["rm", "-rf", "/workspace"] })).rejects.toMatchObject({
      code: "DENIED",
      message: expect.stringContaining("rm is gated"),
    });
    expect(desk.log.some((l) => l.startsWith("shell"))).toBe(false);
    // Still runnable afterwards: the gate refuses a call, it does not wedge the Bot.
    await expect(files.shell({ request_id: "s2", argv: ["ls"] })).resolves.toMatchObject({ exit: 0 });
  });

  it("the gate holds over HTTP, where no harness can skip it", async () => {
    const h = await startHub({
      policy: policy([{ id: "no-shell", tool: "shell", decision: "deny", reason: "this box does not shell" }]),
    });
    try {
      await expect(
        rpc(h.url, "/computer.v1.Agent/Shell", { request_id: "r1", argv: ["ls"] }, h.agent),
      ).rejects.toMatchObject({ code: "DENIED", status: 403 });
    } finally {
      await h.close();
    }
  });
});
