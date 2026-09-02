import type { EnvMap } from "./computers";
import { canMintInvite } from "./invite-access";
import { mintedInviteFromDraft, mintStoredInvite } from "./invite-store";
import { planInvite } from "./invite";
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
  const minted = await (opts.mint ?? mintStoredInvite)(
    parseInviteMintBody(body),
    request,
    env,
    opts.now ?? Date.now(),
  );
  if ("error" in minted) {
    return Response.json({ error: minted.error }, { status: minted.status });
  }
  return Response.json(minted);
}
