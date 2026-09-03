import type { EnvMap } from "./computers";
import { computerById, isComputerOperator } from "./computers";
import { canMintInvite } from "./invite-access";
import { mintedInviteFromDraft, mintStoredInvite } from "./invite-store";
import { mintSecretComputerId, planInvite } from "./invite";
import type { InviteDraft, RedeemFailure } from "./invite";
import type { MintedInvite } from "./invite-store";

export function parseInviteMintBody(body: unknown): {
  computerId?: string;
  kind?: string;
  purpose?: string;
  sender?: string;
  ttlMinutes?: number;
} {
  if (!body || typeof body !== "object") {
    return {};
  }
  const row = body as Record<string, unknown>;
  return {
    computerId: typeof row.computerId === "string" ? row.computerId : undefined,
    kind: typeof row.kind === "string" ? row.kind : undefined,
    purpose: typeof row.purpose === "string" ? row.purpose : undefined,
    sender: typeof row.sender === "string" ? row.sender : undefined,
    ttlMinutes: typeof row.ttlMinutes === "number" ? row.ttlMinutes : undefined,
  };
}

/** The `mint` option `respondToInviteMint` takes, so a test can pass its own. @public */
export type InviteMintFn = (
  input: ReturnType<typeof parseInviteMintBody>,
  request: Request | undefined,
  env: EnvMap,
  now: number,
) => Promise<MintedInvite | RedeemFailure>;

/** Persist-free mint for tests that pin the Eve client wire. */
export async function mintInviteWithoutStore(
  input: ReturnType<typeof parseInviteMintBody>,
  request: Request | undefined,
  env: EnvMap,
  now: number,
): Promise<MintedInvite | RedeemFailure> {
  const planned: InviteDraft | RedeemFailure = planInvite(input, env, now);
  if ("error" in planned) {
    return planned;
  }
  return mintedInviteFromDraft(planned, request, env);
}

/**
 * Which computer this caller may mint for, given what it authenticated with.
 *
 * An operator keeps the body's choice, because an operator is an account that
 * already sees every computer. A caller holding only the mint secret is pinned
 * to `mintSecretComputerId`: it may say that id or say nothing, and naming any
 * other is refused rather than silently redirected, so a misconfigured Bot
 * finds out instead of quietly minting somewhere it did not mean to.
 */
function scopeToMinter(
  input: ReturnType<typeof parseInviteMintBody>,
  email: string | undefined,
  env: EnvMap,
): ReturnType<typeof parseInviteMintBody> | RedeemFailure {
  if (email && isComputerOperator(email, env)) {
    return input;
  }
  const allowed = mintSecretComputerId(env);
  // Compared after `computerById`, so the older `matt` and `vcmc` spellings
  // still match the computer they alias rather than reading as another tenant.
  if (
    input.computerId &&
    computerById(input.computerId, env)?.id !== computerById(allowed, env)?.id
  ) {
    return { error: "This mint secret cannot open that computer.", status: 403 };
  }
  return { ...input, computerId: allowed };
}

export async function respondToInviteMint(
  request: Request,
  email: string | undefined,
  opts: {
    env?: EnvMap;
    mint?: InviteMintFn;
    now?: number;
  } = {},
): Promise<Response> {
  const env = opts.env ?? process.env;
  if (!canMintInvite(request, email, env)) {
    return Response.json({ error: "Not allowed to mint an invite." }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  const scoped = scopeToMinter(parseInviteMintBody(body), email, env);
  if ("error" in scoped) {
    return Response.json({ error: scoped.error }, { status: scoped.status });
  }
  const minted = await (opts.mint ?? mintStoredInvite)(
    scoped,
    request,
    env,
    opts.now ?? Date.now(),
  );
  if ("error" in minted) {
    return Response.json({ error: minted.error }, { status: minted.status });
  }
  return Response.json(minted);
}
