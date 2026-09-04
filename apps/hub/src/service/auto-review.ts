/**
 * Auto Review: a second model reading one proposed action before it runs.
 *
 * `policy.ts` is a handful of regexes, and a regex only catches what somebody
 * thought to name. `packages`, `rm-rf`, `curl-pipe-sh` and `self-rebuild` are
 * the four that were named; everything else on a box with a real browser and
 * a shell is allowed by default. This is the thing that reads the rest.
 *
 * It is not a second policy engine. It plugs into the `check` mechanism the
 * policy service already has: a rule names an argv, the hub spawns it with the
 * request as JSON on stdin, and it prints one verdict. Everything that makes
 * that safe (the timeout, the output cap, the fail-closed default, the
 * deny > ask > allow merge) is already there and is not reimplemented here.
 *
 * Two properties fall out of that merge and are the whole safety argument:
 *
 * - Auto Review can only ever make the outcome stricter. `evaluate` takes the
 *   strongest decision across every matching rule, so an `allow` from this
 *   reviewer cannot overrule the `ask` on `rm -rf`. A wrong model answer costs
 *   a false prompt or a missed catch, never a downgrade of a rule an owner
 *   wrote.
 * - It is additive, so the four named rules keep working when it is off,
 *   misconfigured, or unreachable.
 *
 * No SDK. One `fetch` to an OpenAI-shaped chat completions endpoint, because
 * this is the component that gates the box and its dependency list is part of
 * its threat model. The endpoint is configurable for the same reason a hostname
 * usually is: if the gateway's path differs from the default, that should be an
 * environment variable rather than a patch.
 */

import type { PolicyRequest } from "./policy.ts";

/** What a review can answer. Same three words the policy service speaks. */
type ReviewDecision = "allow" | "ask" | "deny";

interface ReviewVerdict {
  decision: ReviewDecision;
  reason: string;
}

interface AutoReviewConfig {
  apiKey: string;
  /** Gateway model id, `provider/model`, as the rest of the repo spells them. */
  model: string;
  endpoint: string;
  timeoutMs: number;
}

/**
 * A small, fast model on purpose. This sits in front of every shell call the
 * agent makes, so a slow reviewer is a slow computer, and the judgement being
 * asked for (is this destructive, exfiltrating, or irreversible) does not need
 * a frontier model.
 */
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_ENDPOINT = "https://ai-gateway.vercel.sh/v1/chat/completions";
/**
 * Under the policy service's own check timeout, so a slow gateway surfaces as
 * this module's own error rather than a SIGKILL with no explanation.
 */
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Config from the environment, or null when Auto Review is off.
 *
 * Off is the absence of `AI_GATEWAY_API_KEY`, the same key the bridge uses for
 * transcription and the agent uses for chat, rather than a separate switch:
 * one fewer setting, and a deployment with no model access cannot half-enable
 * a reviewer that would then fail on every call.
 */
export function autoReviewConfig(env: NodeJS.ProcessEnv = process.env): AutoReviewConfig | null {
  const apiKey = env.AI_GATEWAY_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  const timeout = Number(env.AUTO_REVIEW_TIMEOUT_MS);
  return {
    apiKey,
    endpoint: env.AI_GATEWAY_URL?.trim() || DEFAULT_ENDPOINT,
    model: env.AUTO_REVIEW_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

const SYSTEM_PROMPT = `You review one proposed action by an autonomous agent working on a persistent Linux computer that belongs to a person. The computer holds their files, their signed-in browser sessions and their chat history. You are the last check before the action runs.

Answer with one decision:
- "allow": routine work. Reading files, listing directories, running tests, editing code in the workspace, navigating and clicking in the browser.
- "ask": the action is plausibly wanted but a person should confirm. It deletes or overwrites something not obviously scratch, spends money, sends a message or email, changes credentials or system configuration, or installs software.
- "deny": no plausible legitimate reading. It exfiltrates credentials or private data to somewhere outside the computer, disables the computer's own safeguards, destroys the workspace wholesale, or attacks another system.

Judge only what is in front of you. Do not assume a benign purpose that the action itself does not show, and do not invent malice for an ordinary command. When an action is ambiguous and the damage would be hard to undo, prefer "ask" over "allow". When it is ambiguous and harmless, prefer "allow" over "ask": a reviewer that stops everything gets turned off.

Reply with only a JSON object: {"decision":"allow"|"ask"|"deny","reason":"<one short sentence, addressed to the person>"}`;

/** The request as the reviewer sees it. Kept small: the model reads the action, not the box. */
function describe(req: PolicyRequest): string {
  if (req.tool === "computer") {
    return `Tool: computer\nAction: ${JSON.stringify(req.action)}`;
  }
  return `Tool: shell\nWorking directory: ${req.cwd}\nCommand: ${JSON.stringify(req.argv)}`;
}

type FetchLike = typeof globalThis.fetch;

/**
 * Ask the reviewer about one action.
 *
 * Throws on every failure rather than returning a lenient default, because the
 * caller is a `check` command whose non-zero exit is what the policy service
 * reads as "broken". Deciding what a broken reviewer means is the rule's job
 * (`fail_open`), not this function's, and burying an `allow` here would take
 * that decision away from the operator.
 */
export async function reviewAction(
  req: PolicyRequest,
  cfg: AutoReviewConfig,
  opts: { fetch?: FetchLike } = {},
): Promise<ReviewVerdict> {
  const call = opts.fetch ?? globalThis.fetch;
  const res = await call(cfg.endpoint, {
    body: JSON.stringify({
      messages: [
        { content: SYSTEM_PROMPT, role: "system" },
        { content: describe(req), role: "user" },
      ],
      model: cfg.model,
      // A verdict is one small object; a reviewer that rambles is a reviewer
      // that times out.
      max_tokens: 200,
      response_format: { type: "json_object" },
      temperature: 0,
    }),
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`auto-review HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("auto-review returned no content");
  }
  return parseVerdict(content);
}

/**
 * The model's reply as a verdict.
 *
 * Tolerant of a fenced block or surrounding prose, because a model told to
 * answer in JSON sometimes explains itself first, and refusing that would fail
 * closed over formatting. Not tolerant of a missing or unknown decision: there
 * is no default here, and inventing one is how a reviewer silently stops
 * reviewing.
 */
export function parseVerdict(raw: string): ReviewVerdict {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("auto-review reply had no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error("auto-review reply was not valid JSON");
  }
  const o = parsed as { decision?: unknown; reason?: unknown };
  if (o.decision !== "allow" && o.decision !== "ask" && o.decision !== "deny") {
    throw new Error("auto-review reply had no allow/ask/deny decision");
  }
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  return {
    decision: o.decision,
    // Named so a human reading the refusal knows a model wrote it, not a rule
    // somebody can go and edit.
    reason: reason || "auto review gave no reason",
  };
}
