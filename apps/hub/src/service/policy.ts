import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { ACTION_TYPES, ComputerError } from "@computer/shared";
import type { Action, ActionType } from "@computer/shared";

/**
 * The approval gate, in the hub.
 *
 * A gate that lives in the harness is not a gate: it protects one client and
 * every other caller walks past it. `pending_checks` ask the model to stop,
 * which is a request, not a control. So policy is evaluated here, before the
 * box is touched, and a refusal is a terminal outcome on the wire (`denied`
 * for computer actions, DENIED for shell) that no harness can talk its way
 * out of.
 *
 * This is deliberately not a policy engine. A handful of rules, three
 * decisions, deny > ask > allow. An operator who needs more writes a `check`
 * command and owns the logic there.
 *
 * FAIL CLOSED. A check that times out, crashes, prints garbage, or does not
 * exist DENIES: the inverse of a hook system that treats a broken hook as
 * consent. A rule that would rather be skipped than block says `fail_open`
 * out loud.
 */

type PolicyDecision = "allow" | "ask" | "deny";

export interface PolicyRule {
  /** Names the rule in the denial the model and human see. */
  id: string;
  /** Which tool this rule guards. */
  tool: "computer" | "shell";
  /** computer only: narrow to one action type. Absent = every action. */
  action?: ActionType;
  /** shell only: JS regex against the argv joined with spaces. Absent = every call. */
  argv?: string;
  /** Static outcome. Required unless `check` is set. */
  decision?: PolicyDecision;
  /**
   * Ask a command instead. It gets the request as JSON on stdin and must
   * print {"decision":"allow"|"ask"|"deny","reason"?:string} on stdout.
   * Anything else: non-zero exit, unparseable output, timeout, ENOENT,
   * is a denial unless fail_open.
   */
  check?: string[];
  /** The opt-out: a broken check contributes nothing instead of denying. */
  fail_open?: boolean;
  /** What to tell the human. Defaults to the rule id. */
  reason?: string;
}

export interface PolicyVerdict {
  decision: PolicyDecision;
  rule: string;
  reason: string;
}

/** What a rule matches against, and what a `check` command reads on stdin. */
export type PolicyRequest =
  | { tool: "computer"; action: Action }
  | { tool: "shell"; argv: string[]; cwd: string };

const ALLOWED: PolicyVerdict = { decision: "allow", reason: "", rule: "" };
const CHECK_TIMEOUT_MS = 5000;
/** Most a check may print before it is treated as broken. A verdict is ~60 bytes. */
const CHECK_OUTPUT_CAP = 64 * 1024;

export class PolicyService {
  /** Each rule beside its compiled `argv` pattern, so the gate compiles none. */
  private readonly rules: CompiledRule[];
  private readonly checkTimeoutMs: number;

  /** No rules is the shipped state: a box with no policy allows everything. */
  constructor(rules: PolicyRule[] = [], opts: { checkTimeoutMs?: number } = {}) {
    // `validateRule` already compiles `argv` to prove it is a valid regex.
    // Keeping what it built is the difference between compiling every rule
    // once at load and compiling every rule again for every action in a batch.
    this.rules = rules.map(compileRule);
    this.checkTimeoutMs = opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  }

  get size(): number {
    return this.rules.length;
  }

  /** deny > ask > allow across every matching rule. */
  async evaluate(req: PolicyRequest): Promise<PolicyVerdict> {
    let asked: PolicyVerdict | undefined;
    for (const rule of this.rules) {
      if (!matches(rule, req)) {
        continue;
      }
      const verdict = await this.decide(rule, req);
      if (verdict.decision === "deny") {
        return verdict;
      }
      if (verdict.decision === "ask" && !asked) {
        asked = verdict;
      }
    }
    return asked ?? ALLOWED;
  }

  private async decide(rule: CompiledRule, req: PolicyRequest): Promise<PolicyVerdict> {
    const reason = rule.reason ?? rule.id;
    if (!rule.check) {
      return { decision: rule.decision ?? "deny", reason, rule: rule.id };
    }
    const out = await runCheck(rule.check, req, this.checkTimeoutMs);
    if (out.decision) {
      return { decision: out.decision, reason: out.reason ?? reason, rule: rule.id };
    }
    if (rule.fail_open) {
      return ALLOWED;
    }
    return {
      decision: "deny",
      rule: rule.id,
      // The failure is the message: a silent fail-closed looks like a bad rule.
      reason: `${reason} (check failed: ${out.error})`,
    };
  }
}

/**
 * Where the Auto Review `check` lives, relative to the repo root the hub runs
 * from. Spelled here rather than in the rule so a deployment that moves the
 * tree changes one line.
 */
const AUTO_REVIEW_CHECK = ["npx", "tsx", "apps/hub/src/host/auto-review-cli.ts"];

/**
 * The rules a box runs with when nobody wrote a policy. None of these deny:
 * a shipped deny would surprise an owner who never saw the file. Each one
 * asks, which the model already handles by stopping and telling the human,
 * and the routine that runs unattended at night gets no further than that.
 *
 * `git` and `npm` under /workspace/eve are the self-rebuild path (Phase 3):
 * a Bot editing its own code is exactly the thing an owner approves once.
 *
 * The four regexes only catch what somebody named, so when a gateway key is
 * configured a fifth rule sends every other shell call to Auto Review
 * (`auto-review.ts`). It is additive and cannot loosen the four, because
 * `evaluate` takes the strongest decision across every matching rule: an
 * `allow` from the reviewer never overrules the `ask` on `rm -rf`.
 *
 * That rule is the one place in this file that sets `fail_open`, deliberately.
 * It sits in front of every shell call, so failing closed would make a gateway
 * outage a box where nothing runs; failing open degrades to exactly the
 * protection that existed before the reviewer did. The four named rules carry
 * no check and so cannot fail at all, which is what makes that safe.
 */
export function defaultPolicyRules(env: NodeJS.ProcessEnv = process.env): PolicyRule[] {
  const autoReview: PolicyRule[] = env.AI_GATEWAY_API_KEY?.trim()
    ? [
        {
          check: AUTO_REVIEW_CHECK,
          fail_open: true,
          id: "auto-review",
          reason: "a second model reviewed this and wants a person to look",
          tool: "shell",
        },
      ]
    : [];
  return [
    ...autoReview,
    {
      argv: String.raw`^(sudo\s+)?(apt|apt-get|dpkg|pip3?|pipx)\s`,
      decision: "ask",
      id: "packages",
      reason: "installing or removing packages needs a person",
      tool: "shell",
    },
    {
      argv: String.raw`^(sudo\s+)?rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b`,
      decision: "ask",
      id: "rm-rf",
      reason: "a recursive forced delete needs a person",
      tool: "shell",
    },
    {
      argv: String.raw`\b(curl|wget)\b.*\|\s*(ba|z|da)?sh\b`,
      decision: "ask",
      id: "curl-pipe-sh",
      reason: "piping a download into a shell needs a person",
      tool: "shell",
    },
    {
      argv: String.raw`^(git|npm|npx|node)\s.*(/workspace/eve|\beve\s+(build|start))`,
      decision: "ask",
      id: "self-rebuild",
      reason: "changing or rebuilding the agent's own code needs a person",
      tool: "shell",
    },
  ];
}

/**
 * Load `data/policy.json`. A missing file means the shipped defaults; a
 * malformed one throws, because a policy the hub cannot read is not a policy
 * it may ignore. An owner who wants no rules writes `[]`.
 */
export function loadPolicy(path: string): PolicyService {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new PolicyService(defaultPolicyRules());
    }
    throw new Error(`policy ${path} could not be read (${(error as Error).message})`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`policy ${path} is not valid JSON (${(error as Error).message})`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`policy ${path} must be a JSON array of rules`);
  }
  return new PolicyService(parsed as PolicyRule[]);
}

/** A validated rule with its `argv` pattern compiled once. */
interface CompiledRule extends PolicyRule {
  pattern?: RegExp;
}

function compileRule(rule: PolicyRule, i: number): CompiledRule {
  const validated = validateRule(rule, i);
  return validated.argv === undefined
    ? validated
    : { ...validated, pattern: argvPattern(`policy rule ${validated.id}`, validated.argv) };
}

function validateRule(rule: PolicyRule, i: number): PolicyRule {
  const at = `policy rule ${rule?.id ?? `#${i}`}`;
  if (!rule || typeof rule.id !== "string" || !rule.id) {
    throw new Error(`${at}: id is required`);
  }
  if (rule.tool !== "computer" && rule.tool !== "shell") {
    throw new Error(`${at}: tool must be computer or shell`);
  }
  const hasCheck = rule.check !== undefined;
  if (hasCheck === (rule.decision !== undefined)) {
    throw new Error(`${at}: set exactly one of decision or check`);
  }
  if (rule.decision && !["allow", "ask", "deny"].includes(rule.decision)) {
    throw new Error(`${at}: decision must be allow, ask or deny`);
  }
  if (hasCheck && (!Array.isArray(rule.check) || rule.check.length === 0)) {
    throw new Error(`${at}: check must be a non-empty argv array`);
  }
  if (rule.action !== undefined && !ACTION_TYPES.includes(rule.action)) {
    throw new Error(`${at}: unknown action ${rule.action}`);
  }
  if (rule.argv !== undefined) {
    argvPattern(at, rule.argv);
  }
  return rule;
}

function argvPattern(at: string, argv: string): RegExp {
  try {
    return new RegExp(argv);
  } catch (error) {
    throw new Error(`${at}: argv is not a valid regex (${(error as Error).message})`, {
      cause: error,
    });
  }
}

function matches(rule: CompiledRule, req: PolicyRequest): boolean {
  if (rule.tool !== req.tool) {
    return false;
  }
  if (req.tool === "computer") {
    return !rule.action || rule.action === req.action.type;
  }
  // No `g` flag, so the compiled pattern carries no lastIndex between calls.
  return !rule.pattern || rule.pattern.test(req.argv.join(" "));
}

interface CheckOutput {
  decision?: PolicyDecision;
  reason?: string;
  error?: string;
}

/**
 * Run one check command on the host, not in the desk container, which is the
 * thing being gated. Every failure path returns `error` and no decision, so
 * the caller denies.
 */
function runCheck(argv: string[], req: PolicyRequest, timeoutMs: number): Promise<CheckOutput> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ error: (error as Error).message });
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let settled = false;
    const done = (result: CheckOutput) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      // A verdict is one small JSON object. A check that streams instead is
      // broken, and a broken check denies, so stopping here stays fail-closed
      // rather than holding an unbounded buffer in the hub for it.
      outBytes += c.length;
      if (outBytes > CHECK_OUTPUT_CAP) {
        child.kill("SIGKILL");
        done({ error: `output over ${CHECK_OUTPUT_CAP} bytes` });
        return;
      }
      out.push(c);
    });
    child.stderr.resume();
    // ENOENT (missing command) and EPIPE both land here.
    child.on("error", (err) => done({ error: err.message }));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(req));
    child.on("close", (code) => {
      if (code !== 0) {
        done({ error: `exit ${code}` });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(out).toString("utf-8"));
      } catch {
        done({ error: "output was not JSON" });
        return;
      }
      const o = parsed as CheckOutput;
      if (o?.decision !== "allow" && o?.decision !== "ask" && o?.decision !== "deny") {
        done({ error: "output had no allow/ask/deny decision" });
        return;
      }
      done({ decision: o.decision, reason: typeof o.reason === "string" ? o.reason : undefined });
    });
  });
}

/** Shell has no `denied` variant on the wire, so a refusal is a loud error. */
export function deniedError(v: PolicyVerdict): ComputerError {
  return new ComputerError(
    "DENIED",
    v.decision === "ask"
      ? `${v.rule}: this needs the human to approve it, ask them, do not retry (${v.reason})`
      : `${v.rule}: ${v.reason}`,
  );
}
