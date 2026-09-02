import { DEFAULT_HUB_URL, trimSlashes } from "./config";

/** Process env or a test fixture. Avoids requiring NODE_ENV on every call. */
export type EnvMap = Record<string, string | undefined>;

export const DEFAULT_COMPUTER_ID = "matt";
export const VCMC_HUB_URL = "https://vcmc-computer.fly.dev";

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
  const mattHub = trimSlashes(
    env.COMPUTER_HUB_URL_MATT ?? env.COMPUTER_HUB_URL ?? env.NEXT_PUBLIC_HUB_URL ?? DEFAULT_HUB_URL,
  );
  const vcmcHub = trimSlashes(env.COMPUTER_HUB_URL_VCMC ?? VCMC_HUB_URL);
  return [
    { hubUrl: mattHub, id: "matt", label: "Matt", setupCodeEnv: "COMPUTER_SETUP_CODE" },
    { hubUrl: vcmcHub, id: "vcmc", label: "VCMC", setupCodeEnv: "COMPUTER_SETUP_CODE_VCMC" },
  ];
}

export function computerById(id: string, env: EnvMap): ComputerRecord | undefined {
  return computersFromEnv(env).find((computer) => computer.id === id);
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

export function defaultComputerId(email: string, env: EnvMap): string {
  const bound = parseComputerBindings(env.COMPUTER_BINDINGS).get(email.trim().toLowerCase());
  if (bound && computerById(bound, env)) {
    return bound;
  }
  const fallback = env.DEFAULT_COMPUTER_ID?.trim();
  if (fallback && computerById(fallback, env)) {
    return fallback;
  }
  return DEFAULT_COMPUTER_ID;
}

/**
 * Who may open every computer. Unset means every signed-in user may switch:
 * AUTH_ALLOWED_EMAILS is still the sign-in gate.
 */
export function isComputerOperator(email: string, env: EnvMap): boolean {
  const operators = parseEmailList(env.COMPUTER_OPERATOR_EMAILS);
  return operators.size === 0 || operators.has(email.trim().toLowerCase());
}

export function accessibleComputers(email: string, env: EnvMap): ComputerRecord[] {
  const all = computersFromEnv(env);
  if (isComputerOperator(email, env)) {
    return all;
  }
  const id = defaultComputerId(email, env);
  const one = all.find((computer) => computer.id === id);
  return one ? [one] : all.slice(0, 1);
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
