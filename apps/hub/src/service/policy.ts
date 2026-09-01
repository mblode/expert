import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { ACTION_TYPES, ComputerError, type Action, type ActionType } from "@computer/shared";

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
 * exist DENIES — the inverse of a hook system that treats a broken hook as
 * consent. A rule that would rather be skipped than block says `fail_open`
 * out loud.
 */

export type PolicyDecision = "allow" | "ask" | "deny";

export type PolicyRule = {
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
   * Anything else — non-zero exit, unparseable output, timeout, ENOENT —
   * is a denial unless fail_open.
   */
  check?: string[];
  /** The opt-out: a broken check contributes nothing instead of denying. */
  fail_open?: boolean;
  /** What to tell the human. Defaults to the rule id. */
  reason?: string;
};

export type PolicyVerdict = { decision: PolicyDecision; rule: string; reason: string };

export type PolicyRequest =
  | { tool: "computer"; action: Action }
  | { tool: "shell"; argv: string[]; cwd: string };

const ALLOWED: PolicyVerdict = { decision: "allow", rule: "", reason: "" };
const CHECK_TIMEOUT_MS = 5000;

export class PolicyService {
  private readonly rules: PolicyRule[];
  private readonly checkTimeoutMs: number;

  /** No rules is the shipped state: a box with no policy allows everything. */
  constructor(rules: PolicyRule[] = [], opts: { checkTimeoutMs?: number } = {}) {
    this.rules = rules.map(validateRule);
    this.checkTimeoutMs = opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  }

  get size(): number {
    return this.rules.length;
  }

  /** deny > ask > allow across every matching rule. */
  async evaluate(req: PolicyRequest): Promise<PolicyVerdict> {
    let asked: PolicyVerdict | undefined;
    for (const rule of this.rules) {
      if (!matches(rule, req)) continue;
      const verdict = await this.decide(rule, req);
      if (verdict.decision === "deny") return verdict;
      if (verdict.decision === "ask" && !asked) asked = verdict;
    }
    return asked ?? ALLOWED;
  }

  private async decide(rule: PolicyRule, req: PolicyRequest): Promise<PolicyVerdict> {
    const reason = rule.reason ?? rule.id;
    if (!rule.check) {
      return { decision: rule.decision ?? "deny", rule: rule.id, reason };
    }
    const out = await runCheck(rule.check, req, this.checkTimeoutMs);
    if (out.decision) {
      return { decision: out.decision, rule: rule.id, reason: out.reason ?? reason };
    }
    if (rule.fail_open) return ALLOWED;
    return {
      decision: "deny",
      rule: rule.id,
      // The failure is the message: a silent fail-closed looks like a bad rule.
      reason: `${reason} (check failed: ${out.error})`,
    };
  }
}

/**
 * Load `data/policy.json`. A missing file means no rules; a malformed one
 * throws, because a policy the hub cannot read is not a policy it may ignore.
 */
export function loadPolicy(path: string): PolicyService {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new PolicyService();
    throw new Error(`policy ${path} could not be read (${(err as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`policy ${path} is not valid JSON (${(err as Error).message})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`policy ${path} must be a JSON array of rules`);
  }
  return new PolicyService(parsed as PolicyRule[]);
}

function validateRule(rule: PolicyRule, i: number): PolicyRule {
  const at = `policy rule ${rule?.id ?? `#${i}`}`;
  if (!rule || typeof rule.id !== "string" || !rule.id) throw new Error(`${at}: id is required`);
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
    try {
      new RegExp(rule.argv);
    } catch (err) {
      throw new Error(`${at}: argv is not a valid regex (${(err as Error).message})`);
    }
  }
  return rule;
}

function matches(rule: PolicyRule, req: PolicyRequest): boolean {
  if (rule.tool !== req.tool) return false;
  if (req.tool === "computer") return !rule.action || rule.action === req.action.type;
  return !rule.argv || new RegExp(rule.argv).test(req.argv.join(" "));
}

type CheckOutput = { decision?: PolicyDecision; reason?: string; error?: string };

/**
 * Run one check command on the host — not in the desk container, which is the
 * thing being gated. Every failure path returns `error` and no decision, so
 * the caller denies.
 */
function runCheck(argv: string[], req: PolicyRequest, timeoutMs: number): Promise<CheckOutput> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ error: (err as Error).message });
      return;
    }
    const out: Buffer[] = [];
    let settled = false;
    const done = (result: CheckOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => out.push(c));
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
        parsed = JSON.parse(Buffer.concat(out).toString("utf8"));
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
      ? `${v.rule}: this needs the human to approve it — ask them, do not retry (${v.reason})`
      : `${v.rule}: ${v.reason}`,
  );
}
