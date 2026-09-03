import { DEFAULT_HUB_URL, trimSlashes } from "./config";

/** Process env or a test fixture. Avoids requiring NODE_ENV on every call. */
export type EnvMap = Record<string, string | undefined>;

export const VIBEY_HUB_URL = "https://vcmc-computer.fly.dev";

/** Live COMPUTER_BINDINGS and stored seats may still say matt/vcmc. */
const COMPUTER_ID_ALIASES: Record<string, string> = { matt: "blode", vcmc: "vibey" };

function canonicalComputerId(id: string): string {
  return COMPUTER_ID_ALIASES[id] ?? id;
}

export interface ComputerRecord {
  id: string;
  label: string;
  hubUrl: string;
  /** Env var that holds this computer's Pair setup code. Never the code itself. */
  setupCodeEnv: string;
}

export interface ComputerChoice {
  id: string;
  label: string;
}

/** Seeded tenants. Hub URLs can be overridden per id; setup codes stay in env. */
export function computersFromEnv(env: EnvMap): ComputerRecord[] {
  const blodeHub = trimSlashes(
    env.COMPUTER_HUB_URL_BLODE ??
      env.COMPUTER_HUB_URL_MATT ??
      env.COMPUTER_HUB_URL ??
      env.NEXT_PUBLIC_HUB_URL ??
      DEFAULT_HUB_URL,
  );
  const vibeyHub = trimSlashes(
    env.COMPUTER_HUB_URL_VIBEY ?? env.COMPUTER_HUB_URL_VCMC ?? VIBEY_HUB_URL,
  );
  return [
    { hubUrl: blodeHub, id: "blode", label: "Blode", setupCodeEnv: "COMPUTER_SETUP_CODE" },
    { hubUrl: vibeyHub, id: "vibey", label: "Vibey", setupCodeEnv: "COMPUTER_SETUP_CODE_VCMC" },
  ];
}

export function computerById(id: string, env: EnvMap): ComputerRecord | undefined {
  const canonical = canonicalComputerId(id);
  return computersFromEnv(env).find((computer) => computer.id === canonical);
}

/** `email:computerId,...` (case-insensitive email). First binding for an email wins. */
export function parseComputerBindings(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (raw ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const split = trimmed.indexOf(":");
    if (split <= 0 || split === trimmed.length - 1) {
      continue;
    }
    const email = trimmed.slice(0, split).trim().toLowerCase();
    const computerId = trimmed.slice(split + 1).trim();
    if (email && computerId && !out.has(email)) {
      out.set(email, computerId);
    }
  }
  return out;
}

function parseEmailList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The computer this account is bound to, or nothing.
 *
 * Fail closed. This used to fall back to the hardcoded "blode" when an email
 * had no binding, which was harmless while one person had one computer and is
 * not harmless now: an account is the tenant boundary here, so an allowed
 * email nobody remembered to bind would land on someone else's machine and
 * `Pair` an owner seat there with that machine's setup code.
 *
 * `DEFAULT_COMPUTER_ID` stays as an explicit opt-in, because a single-computer
 * deployment should not have to list every address. Setting it is a decision
 * to bind every unbound account to that computer.
 */
export function boundComputerId(email: string, env: EnvMap): string | undefined {
  const bound = parseComputerBindings(env.COMPUTER_BINDINGS).get(email.trim().toLowerCase());
  const fromBinding = bound ? computerById(bound, env) : undefined;
  if (fromBinding) {
    return fromBinding.id;
  }
  const fallback = env.DEFAULT_COMPUTER_ID?.trim();
  return fallback ? computerById(fallback, env)?.id : undefined;
}

/**
 * Who may open every computer, and mint invites on one.
 *
 * Listed addresses only. An unset list used to mean everyone, which made the
 * binding above unreachable: every signed-in account was an operator and saw
 * every computer. Unset now means nobody, so an account still reaches the
 * computer it is bound to and simply loses the switcher until it is listed.
 */
export function isComputerOperator(email: string, env: EnvMap): boolean {
  return parseEmailList(env.COMPUTER_OPERATOR_EMAILS).has(email.trim().toLowerCase());
}

/** Every computer for an operator, the bound one for anyone else, none when unbound. */
export function accessibleComputers(email: string, env: EnvMap): ComputerRecord[] {
  const all = computersFromEnv(env);
  if (isComputerOperator(email, env)) {
    return all;
  }
  const id = boundComputerId(email, env);
  const one = id ? all.find((computer) => computer.id === id) : undefined;
  return one ? [one] : [];
}

export function choicesOf(computers: readonly ComputerRecord[]): ComputerChoice[] {
  return computers.map(({ id, label }) => ({ id, label }));
}

export function setupCodeFor(computer: ComputerRecord, env: EnvMap): string | undefined {
  const code = env[computer.setupCodeEnv];
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/**
 * Why a hub call did not produce what was asked for.
 *
 * `code` is the hub's own `ErrorCode` when it sent an envelope, and absent
 * when the hub could not be reached at all. The difference matters to the
 * issuer path: a rejected credential is worth forgetting, an unreachable box
 * is not.
 */
export interface HubFailure {
  error: string;
  code?: string;
}

/**
 * One POST to a Seat RPC on a computer's hub.
 *
 * Pair is the one call with no bearer; everything else carries the token it
 * was minted with. Errors come back as `{ error }` rather than thrown, so a
 * page renders a sentence instead of a stack.
 */
async function hubPost<T>(
  call: {
    body: Record<string, unknown>;
    computer: ComputerRecord;
    method: string;
    /** What to say when the hub answers with a status but no error envelope. */
    whenFailed: (status: number) => string;
    /** Absent for Pair, which is the hub's one unauthenticated write. */
    token?: string;
  },
  fetchImpl: typeof fetch,
): Promise<T | HubFailure> {
  const { body, computer, method, token, whenFailed } = call;
  try {
    const res = await fetchImpl(`${computer.hubUrl}/computer.v1.Seat/${method}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const envelope = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      return {
        error: envelope?.message ?? whenFailed(res.status),
        ...(envelope?.code ? { code: envelope.code } : {}),
      };
    }
    return (payload ?? {}) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reach the computer.";
    return { error: `Could not reach the computer at ${computer.hubUrl}: ${message}` };
  }
}

export async function pairComputer(
  computer: ComputerRecord,
  env: EnvMap,
  fetchImpl: typeof fetch = fetch,
): Promise<{ token: string } | HubFailure> {
  const code = setupCodeFor(computer, env);
  if (!code) {
    return {
      error: `The web server is missing ${computer.setupCodeEnv}, so it cannot attach to the ${computer.label} computer.`,
    };
  }
  const payload = await hubPost<{ token?: unknown }>(
    {
      body: { code },
      computer,
      method: "Pair",
      whenFailed: (status) => `Could not pair with the computer (${status}).`,
    },
    fetchImpl,
  );
  if ("error" in payload) {
    return payload;
  }
  const { token } = payload;
  if (typeof token !== "string" || !token) {
    return { error: "The computer accepted pairing but did not return a seat token." };
  }
  return { token };
}

/** What the control plane asks a hub to mint. Mirrors `IssueRequest` in api/computer.proto. */
export interface SeatRequest {
  /** A role from `ROLE_METHODS`, spelled as the hub spells it. */
  role: string;
  /**
   * How long the seat may live. The hub caps it; this never raises that cap.
   * Absent asks for no expiry, which only an owner may grant and only the
   * control plane's own `issuer` grant is minted with.
   */
  ttlMs?: number;
  /** Bind the seat to one screen. Absent = any screen, which an invite never wants. */
  display?: number;
  /** Shown in the owner's seat list. Never a secret. */
  label?: string;
  /** Narrows the role's method set. The hub is what enforces it. */
  methods?: readonly string[];
  /** A token this grant replaces, revoked with the same issuer that mints it. */
  replaces?: string;
  /** Who the seat is for, as this control plane names them. */
  subject?: string;
}

export interface IssuedSeat {
  /** ISO, or empty when the hub minted something that never expires. */
  expiresAt: string;
  role: string;
  token: string;
}

/** `ttl_sec` is an integer, and 0 on the wire means "never expires". */
function ttlSeconds(ttlMs: number): number {
  return Math.max(1, Math.floor(ttlMs / 1000));
}

/**
 * What a grant path is handed so it can mint a seat.
 *
 * No `env` and no setup code: whatever implements this already holds the
 * credential it issues with. That is the whole point of the issuer, spelled
 * in the type, so a future caller cannot quietly reintroduce a per-request
 * `Pair` by reaching for a setup code that is no longer in the signature.
 */
export type IssueSeatFn = (
  computer: ComputerRecord,
  request: SeatRequest,
) => Promise<IssuedSeat | HubFailure>;

/**
 * Mint a scoped seat with an `issuer` grant this control plane already holds.
 *
 * One call. No `Pair`, no owner anywhere in the request, and nothing to unwind
 * if the process dies mid-flight. Before this, every grant paired an owner
 * with the computer's setup code, spent it on one `Issue` and revoked it in a
 * `finally`: a crash in that window stranded an unexpiring owner in the hub's
 * seats.json, and the Vercel deployment was a standing owner credential for
 * every tenant. Resolving the issuer, and refusing when there is none, is
 * `issuer.ts`; this function only speaks to the hub.
 */
export async function issueSeat(
  computer: ComputerRecord,
  issuer: string,
  request: SeatRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<IssuedSeat | HubFailure> {
  if (request.replaces) {
    // Best effort, and it can legitimately fail: an issuer may not revoke a
    // privileged seat, so a token stored by an older control plane (an owner,
    // before invites were scoped) survives its own replacement and has to be
    // revoked at the box. The new grant is still the one that gets handed out.
    await hubPost(
      {
        body: { token: request.replaces },
        computer,
        method: "Revoke",
        token: issuer,
        whenFailed: () => "",
      },
      fetchImpl,
    );
  }
  const issued = await hubPost<{ expires_at?: unknown; role?: unknown; token?: unknown }>(
    {
      // Empty fields are omitted, not sent empty: the hub reads `display: 0`
      // as any screen and `methods: []` as a seat that may call nothing.
      // An absent `ttlMs` is an absent `ttl_sec`, which is "no expiry", and
      // the hub refuses that for every role but an owner-issued one.
      body: {
        role: request.role,
        ...(request.ttlMs === undefined ? {} : { ttl_sec: ttlSeconds(request.ttlMs) }),
        ...(request.display === undefined ? {} : { display: request.display }),
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(request.methods?.length ? { methods: [...request.methods] } : {}),
        ...(request.subject === undefined ? {} : { subject: request.subject }),
      },
      computer,
      method: "Issue",
      token: issuer,
      whenFailed: (status) => `Could not issue a seat on the computer (${status}).`,
    },
    fetchImpl,
  );
  if ("error" in issued) {
    return issued;
  }
  const { token } = issued;
  if (typeof token !== "string" || !token) {
    return { error: "The computer accepted the grant but did not return a seat token." };
  }
  return {
    expiresAt: typeof issued.expires_at === "string" ? issued.expires_at : "",
    role: typeof issued.role === "string" && issued.role ? issued.role : request.role,
    token,
  };
}

/** End a seat early. A seat may always revoke itself, whatever its role. */
export async function revokeSeat(
  computer: ComputerRecord,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await hubPost({ body: {}, computer, method: "Revoke", token, whenFailed: () => "" }, fetchImpl);
}
