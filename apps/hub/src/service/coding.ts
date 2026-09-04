/**
 * Coding sessions, delegated off the box.
 *
 * Computer use and coding are different jobs on different machines. The desk
 * is a screen with a browser signed into things; a coding session is an hour
 * of tests with no screen at all. Running one here costs six things at once,
 * each of them written down elsewhere in this tree: a harness under the
 * supervisor has its own bash and never reaches `PolicyService` or the seat
 * (`ARCHITECTURE.md` section 4), `shell` caps at 120 s so a session cannot be
 * an RPC (`api/DESIGN.md`), a worktree is not a boundary because the Machine
 * is the only one there is, there is no egress policy, a running session pins
 * a Machine that would otherwise suspend (`docs/plans/gateway.md`), and a
 * child started through `asBox` shares its uid with the model's own `shell`,
 * so its credential is readable out of `/proc`. Every one of those is a cost
 * that disappears when the work runs somewhere else.
 *
 * So this service is a client, not a runtime. It hands a task and a repo to
 * Cursor's Cloud Agents API and mirrors what comes back into a conversation,
 * which is what keeps one record: hello.expert, the phone and WhatsApp read
 * the session out of the hub's own log rather than out of a provider's
 * dashboard. `docs/plans/coding-sessions.md` is the design and says which
 * work stays on the box (this repository's own deploy loop, anything needing
 * the signed-in browser or the desk to verify) and why that is the exception.
 *
 * No SDK, one `fetch`, for the reason `auto-review.ts` gives: a component
 * holding a credential that can write to every repository the token can see
 * has a dependency list that is part of its threat model.
 */

import { ComputerError } from "@computer/shared";
import type { CodingSessionState, Conversation } from "@computer/shared";
import { SEAT_HUMAN_REF } from "./conversations.ts";
import type { ConversationRegistry } from "./conversations.ts";

export interface CodingConfig {
  apiKey: string;
  /** Base URL, no trailing slash. Configurable for the same reason a hostname usually is. */
  endpoint: string;
  timeoutMs: number;
}

const DEFAULT_ENDPOINT = "https://api.cursor.com";
/**
 * A launch is one POST and a refresh is two GETs, none of which waits on the
 * work itself: the run is asynchronous by construction, so this timeout is
 * about the API answering, not about the coding finishing.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Absent key means no coding sessions on this computer, and the RPCs answer
 * `DAEMON_DOWN` the way the WhatsApp ones do without a bridge. Deliberately
 * not a separate on/off switch: a deployment with no key cannot half-enable
 * a runner that then fails on every call.
 */
export function codingConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CodingConfig | undefined {
  const apiKey = env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }
  const timeout = Number(env.CURSOR_API_TIMEOUT_MS);
  return {
    apiKey,
    endpoint: (env.CURSOR_API_URL?.trim() || DEFAULT_ENDPOINT).replace(/\/$/, ""),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

/** What a client renders: the thread's id, where the work is, and what came out. */
export interface CodingSession {
  conversation_id: string;
  /** The runner's durable handle for this session. */
  agent: string;
  repo: string;
  state: CodingSessionState;
  /** The runner's own page, so a human can watch it there when they want to. */
  url: string;
  branch: string;
  pr_url: string;
  /** The run's closing text once it has one, empty while it is working. */
  summary: string;
}

export interface StartCodingSession {
  bot: string;
  repo: string;
  prompt: string;
  /** Branch or commit to start from. Absent = the repository's default. */
  ref?: string;
  /** Ask the runner to open the pull request itself when it finishes. */
  auto_create_pr?: boolean;
  /** Model id, passed straight through. Absent = whatever the account defaults to. */
  model?: string;
}

/** Only what this service reads. The API returns more and is free to. */
interface RunSnapshot {
  id: string;
  status: string;
  result?: string;
  git?: { branches?: { branch?: string; prUrl?: string }[] };
}

interface AgentSnapshot {
  id: string;
  url?: string;
  latestRunId?: string;
}

/**
 * The runner's run states, in the session vocabulary the whole product
 * speaks. `CANCELLED` and `EXPIRED` both become `stale` because they are the
 * same fact to a person reading the thread: nobody is working on it and
 * nothing more is coming. An unknown state is `pending` rather than an
 * error, so a state added upstream reads as "not finished" instead of
 * turning a working session red.
 */
const RUN_STATES: Record<string, CodingSessionState> = {
  CANCELLED: "stale",
  CREATING: "pending",
  ERROR: "error",
  EXPIRED: "stale",
  FINISHED: "complete",
  RUNNING: "active",
};

/** A GitHub repository URL, which is the only source the runner takes. */
const REPO_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class CodingService {
  constructor(
    private readonly conversations: ConversationRegistry,
    private readonly config: CodingConfig | undefined = codingConfigFromEnv(),
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get enabled(): boolean {
    return this.config !== undefined;
  }

  /**
   * Launch one, then record it.
   *
   * The conversation is resolved from the agent id the runner hands back
   * rather than minted first, so a launch that fails leaves no empty thread
   * behind. The prompt is recorded as the human's own words, because that is
   * what it is: the person at the seat asked for this.
   */
  async start(req: StartCodingSession): Promise<CodingSession> {
    const config = this.require();
    const repo = req.repo
      .trim()
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
    if (!REPO_RE.test(repo)) {
      throw new ComputerError("VALIDATION", "repo must be a https://github.com/<owner>/<name> URL");
    }
    if (!req.prompt.trim()) {
      throw new ComputerError("VALIDATION", "prompt is required");
    }
    const body = {
      autoCreatePR: req.auto_create_pr ?? false,
      ...(req.model ? { model: { id: req.model } } : {}),
      prompt: { text: req.prompt },
      repos: [{ url: repo, ...(req.ref ? { startingRef: req.ref } : {}) }],
    };
    const created = await this.call(config, "POST", "/v1/agents", body);
    const agent = readAgent(created);
    const conversation = this.conversations.resolve(
      req.bot,
      { agent: agent.id, kind: "code", repo },
      [
        { bot: req.bot, kind: "bot" },
        { kind: "human", ref: SEAT_HUMAN_REF },
      ],
    );
    // `append`, not `send`: the model's turn rules are about the model's
    // voice, and nothing here is the model speaking. A widget waiting on the
    // human in this thread must not stop a run's status from being recorded.
    this.conversations.append(
      conversation.id,
      { kind: "human", ref: SEAT_HUMAN_REF },
      { kind: "human", text: req.prompt },
    );
    const run = readRun(created) ?? (await this.latestRun(config, agent));
    return this.record(conversation.id, repo, agent, run);
  }

  /**
   * Re-read one and record anything new.
   *
   * Polled rather than streamed, and that is the tracer's whole delivery
   * story: a client asks, the hub asks the runner, and a status that has not
   * moved appends nothing. Idempotency comes from the log itself rather than
   * from a cursor held in memory, so a hub that restarts mid-session does not
   * repeat the last line it wrote.
   */
  async refresh(conversationId: string): Promise<CodingSession> {
    const config = this.require();
    const conversation = this.conversations.byId(conversationId);
    if (conversation.route.kind !== "code") {
      throw new ComputerError(
        "VALIDATION",
        `conversation ${conversationId} is not a coding session`,
      );
    }
    const agent = readAgent(
      await this.call(config, "GET", `/v1/agents/${encodeURIComponent(conversation.route.agent)}`),
    );
    const run = await this.latestRun(config, agent);
    return this.record(conversation.id, conversation.route.repo, agent, run);
  }

  /**
   * Every coding session a set of Bots owns.
   *
   * Unordered, like `Seat.Conversations` beside it: each record carries its
   * own `updated_at` through that RPC and a client that wants newest-first
   * has what it needs, so a second ordering rule here would be one more
   * thing for the two lists to disagree about.
   */
  list(bots: Set<string>): { conversation_id: string; agent: string; repo: string }[] {
    return this.conversations
      .list()
      .filter((c) => c.route.kind === "code" && bots.has(c.bot))
      .map((c) => ({
        agent: (c.route as { agent: string }).agent,
        conversation_id: c.id,
        repo: (c.route as { repo: string }).repo,
      }));
  }

  private async latestRun(
    config: CodingConfig,
    agent: AgentSnapshot,
  ): Promise<RunSnapshot | undefined> {
    if (!agent.latestRunId) {
      return undefined;
    }
    const path = `/v1/agents/${encodeURIComponent(agent.id)}/runs/${encodeURIComponent(agent.latestRunId)}`;
    return readRun(await this.call(config, "GET", path));
  }

  /** Build the view, append the status line when it says something new. */
  private record(
    conversationId: string,
    repo: string,
    agent: AgentSnapshot,
    run: RunSnapshot | undefined,
  ): CodingSession {
    const branch = run?.git?.branches?.[0];
    const session: CodingSession = {
      agent: agent.id,
      branch: branch?.branch ?? "",
      conversation_id: conversationId,
      pr_url: branch?.prUrl ?? "",
      repo,
      state: run ? (RUN_STATES[run.status] ?? "pending") : "pending",
      summary: run?.result ?? "",
      url: agent.url ?? "",
    };
    const line = statusLine(session);
    if (line !== this.lastLine(conversationId)) {
      this.conversations.append(
        conversationId,
        { kind: "system" },
        { images: [], kind: "text", text: line },
      );
    }
    return session;
  }

  /** The tail of the log, read by seq so a long thread is not walked. */
  private lastLine(conversationId: string): string | undefined {
    const record: Conversation = this.conversations.byId(conversationId);
    if (record.last_seq === 0) {
      return undefined;
    }
    const tail = this.conversations
      .page(conversationId, String(record.last_seq - 1), 1)
      .entries.at(-1);
    return tail?.kind === "text" ? tail.text : undefined;
  }

  private require(): CodingConfig {
    if (!this.config) {
      throw new ComputerError("DAEMON_DOWN", "coding sessions are not configured on this computer");
    }
    return this.config;
  }

  /**
   * One call to the runner.
   *
   * A 4xx is the request's problem and comes back as `VALIDATION`; anything
   * else, including a timeout, is the dependency not answering and comes
   * back as `DAEMON_DOWN`, which is the same split a caller needs to know
   * whether retrying is worth anything. The key is never in a message.
   */
  private async call(
    config: CodingConfig,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${config.endpoint}${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        method,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const why = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
      throw new ComputerError("DAEMON_DOWN", `the coding runner ${why}`);
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      const text = raw.slice(0, 500);
      if (res.status >= 400 && res.status < 500) {
        throw new ComputerError(
          "VALIDATION",
          `the coding runner refused it: ${res.status} ${text}`,
        );
      }
      throw new ComputerError("DAEMON_DOWN", `the coding runner answered ${res.status}`);
    }
    return await res.json().catch(() => {
      throw new ComputerError("DAEMON_DOWN", "the coding runner sent something that is not JSON");
    });
  }
}

/**
 * What a person reads in the thread.
 *
 * One composed line per state rather than a structured event, because the
 * conversation's bodies are deliberately the four that already exist and a
 * fifth kind for this would be a second thing to render. Exact, so comparing
 * it against the tail is the whole idempotency check.
 */
function statusLine(session: CodingSession): string {
  const where = session.branch ? ` on ${session.branch}` : "";
  switch (session.state) {
    case "pending": {
      return `Coding session queued against ${session.repo}.`;
    }
    case "active": {
      return `Coding session working on ${session.repo}${where}.`;
    }
    case "complete": {
      const pr = session.pr_url ? ` Pull request: ${session.pr_url}` : "";
      const summary = session.summary ? ` ${session.summary}` : "";
      return `Coding session finished${where}.${pr}${summary}`;
    }
    case "error": {
      return `Coding session failed on ${session.repo}.`;
    }
    default: {
      return `Coding session on ${session.repo} stopped without finishing.`;
    }
  }
}

/**
 * The create call answers with the agent and its first run, and the docs
 * describe that as two objects rather than fixing the envelope, so both
 * shapes are read. A response this cannot find an id in is the runner
 * changing under us, which is a `DAEMON_DOWN` and not a silent empty view.
 */
function readAgent(payload: unknown): AgentSnapshot {
  const root = asRecord(payload) ?? {};
  const agent = asRecord(root.agent) ?? root;
  const { id } = agent;
  if (typeof id !== "string" || !id) {
    throw new ComputerError("DAEMON_DOWN", "the coding runner did not name the session it made");
  }
  return {
    id,
    ...(typeof agent.latestRunId === "string" ? { latestRunId: agent.latestRunId } : {}),
    ...(typeof agent.url === "string" ? { url: agent.url } : {}),
  };
}

function readRun(payload: unknown): RunSnapshot | undefined {
  const root = asRecord(payload) ?? {};
  const run = asRecord(root.run) ?? root;
  if (typeof run.id !== "string" || typeof run.status !== "string") {
    return undefined;
  }
  const git = asRecord(run.git);
  const branches = Array.isArray(git?.branches) ? git.branches : [];
  return {
    id: run.id,
    status: run.status,
    ...(typeof run.result === "string" ? { result: run.result } : {}),
    git: {
      branches: branches.map((b) => {
        const entry = asRecord(b);
        return {
          ...(typeof entry?.branch === "string" ? { branch: entry.branch } : {}),
          ...(typeof entry?.prUrl === "string" ? { prUrl: entry.prUrl } : {}),
        };
      }),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
