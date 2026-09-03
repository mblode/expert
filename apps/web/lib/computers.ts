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

export function parseEmailList(raw: string | undefined): Set<string> {
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

export async function pairComputer(
  computer: ComputerRecord,
  env: EnvMap,
  fetchImpl: typeof fetch = fetch,
): Promise<{ token: string } | { error: string }> {
  const code = setupCodeFor(computer, env);
  if (!code) {
    return {
      error: `The web server is missing ${computer.setupCodeEnv}, so it cannot attach to the ${computer.label} computer.`,
    };
  }
  try {
    const res = await fetchImpl(`${computer.hubUrl}/computer.v1.Seat/Pair`, {
      body: JSON.stringify({ code }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const envelope = (payload as { error?: { message?: string } } | null)?.error;
      return { error: envelope?.message ?? `Could not pair with the computer (${res.status}).` };
    }
    const token = (payload as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || !token) {
      return { error: "The computer accepted pairing but did not return a seat token." };
    }
    return { token };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reach the computer.";
    return { error: `Could not reach the computer at ${computer.hubUrl}: ${message}` };
  }
}
