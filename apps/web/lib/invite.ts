import type { ComputerRecord, EnvMap } from "./computers";
import { computerById, pairComputer } from "./computers";
import { newOpaqueToken, sha256Hex } from "./secret";

export const INVITE_PURPOSES = ["desk", "plugins"] as const;
export type InvitePurpose = (typeof INVITE_PURPOSES)[number];

/** WhatsApp group computer. Mint defaults here unless the body names another id. */
export const DEFAULT_INVITE_COMPUTER_ID = "vibey";
export const DEFAULT_INVITE_TTL_MINUTES = 30;
export const MAX_INVITE_TTL_MINUTES = 240;

export interface InviteRecord {
  computerId: string;
  expiresAt: number;
  purpose: InvitePurpose;
  seatToken?: string;
  senderHash?: string;
  tokenHash: string;
}

export interface InviteDraft {
  computerId: string;
  expiresAt: number;
  purpose: InvitePurpose;
  senderHash?: string;
  token: string;
  tokenHash: string;
}

export interface RedeemFailure {
  error: string;
  status: 400 | 403 | 404 | 410 | 502;
}

export interface SeatGrant {
  computer: ComputerRecord;
  persist: boolean;
  seatToken: string;
}

export function isInvitePurpose(value: string): value is InvitePurpose {
  return (INVITE_PURPOSES as readonly string[]).includes(value);
}

export function hashInviteToken(token: string): string {
  return sha256Hex(token);
}

export function hashInviteSender(sender: string): string {
  return sha256Hex(sender);
}

/**
 * Eve's client sends `{ kind: "desk" | "plugin" }`. Operators still send
 * `purpose`. Singular `plugin` is the public name; the path stays `/plugins`.
 */
export function resolveInvitePurpose(input: { kind?: string; purpose?: string }): string {
  const raw = (input.purpose ?? input.kind ?? "").trim();
  return raw === "plugin" ? "plugins" : raw;
}

export function planInvite(
  input: {
    computerId?: string;
    kind?: string;
    purpose?: string;
    sender?: string;
    ttlMinutes?: number;
  },
  env: EnvMap,
  now: number,
): InviteDraft | RedeemFailure {
  const purpose = resolveInvitePurpose(input);
  if (!isInvitePurpose(purpose)) {
    return { error: "Say whether this link is for the desk or for plugins.", status: 400 };
  }

  const ttl =
    typeof input.ttlMinutes === "number" && Number.isFinite(input.ttlMinutes)
      ? input.ttlMinutes
      : DEFAULT_INVITE_TTL_MINUTES;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_INVITE_TTL_MINUTES) {
    return {
      error: `A link lasts between 1 and ${MAX_INVITE_TTL_MINUTES} minutes.`,
      status: 400,
    };
  }

  const wanted = (input.computerId ?? DEFAULT_INVITE_COMPUTER_ID).trim();
  const computer = computerById(wanted, env);
  if (!computer) {
    return { error: "That computer is not on this control plane.", status: 400 };
  }

  const token = newOpaqueToken();
  const sender = input.sender?.trim();
  return {
    computerId: computer.id,
    expiresAt: now + ttl * 60_000,
    purpose,
    ...(sender ? { senderHash: hashInviteSender(sender) } : {}),
    token,
    tokenHash: hashInviteToken(token),
  };
}

export function inspectInvite(
  invite: InviteRecord | undefined,
  purpose: InvitePurpose,
  env: EnvMap,
  now: number,
): { computer: ComputerRecord } | RedeemFailure {
  if (!invite) {
    return { error: "This link is not valid.", status: 404 };
  }
  if (invite.expiresAt <= now) {
    return { error: "This link has expired. Ask for a new one.", status: 410 };
  }
  if (invite.purpose !== purpose) {
    return {
      error:
        invite.purpose === "desk"
          ? "This link is for the desk, not plugins."
          : "This link is for plugins, not the desk.",
      status: 404,
    };
  }
  const computer = computerById(invite.computerId, env);
  if (!computer || computer.id !== invite.computerId) {
    return { error: "That computer is not on this control plane.", status: 404 };
  }
  return { computer };
}

/**
 * Pair the invite's own computer. A Vibey link never talks to Blode, even
 * when the web server's default tenant is Blode.
 */
export async function grantInviteSeat(
  invite: InviteRecord,
  purpose: InvitePurpose,
  env: EnvMap,
  now: number,
  pair: typeof pairComputer = pairComputer,
): Promise<SeatGrant | RedeemFailure> {
  const inspected = inspectInvite(invite, purpose, env, now);
  if ("error" in inspected) {
    return inspected;
  }
  const { computer } = inspected;
  if (invite.seatToken) {
    return { computer, persist: false, seatToken: invite.seatToken };
  }
  const paired = await pair(computer, env);
  if ("error" in paired) {
    return { error: paired.error, status: 502 };
  }
  return { computer, persist: true, seatToken: paired.token };
}
