import type { ComputerRecord, EnvMap, IssueSeatFn, SeatRequest } from "./computers";
import { computerById } from "./computers";
import { newOpaqueToken, sha256Hex } from "./secret";

export const INVITE_PURPOSES = ["desk", "plugins"] as const;
export type InvitePurpose = (typeof INVITE_PURPOSES)[number];

/** WhatsApp group computer. Mint defaults here unless the body names another id. */
export const DEFAULT_INVITE_COMPUTER_ID = "vibey";
const DEFAULT_INVITE_TTL_MINUTES = 30;
export const MAX_INVITE_TTL_MINUTES = 240;

/**
 * The one computer a mint secret may open.
 *
 * An operator is an account and the account is the tenant boundary, so what an
 * operator may mint for is already decided by `accessibleComputers`. A mint
 * secret is not an account: it is one shared string on a Bot, and until this it
 * read `computerId` straight off the request body, so Vibey's Eve could mint a
 * desk link on another computer and redeem a seat there. `INVITE_MINT_COMPUTER_ID` moves
 * that decision to the deployment; unset means the computer the secret was
 * introduced for.
 */
export function mintSecretComputerId(env: EnvMap): string {
  return env.INVITE_MINT_COMPUTER_ID?.trim() || DEFAULT_INVITE_COMPUTER_ID;
}

export interface InviteRecord {
  computerId: string;
  expiresAt: number;
  purpose: InvitePurpose;
  seatToken?: string;
  /**
   * The role `seatToken` was minted with. Absent on a record written before
   * this control plane issued scoped seats, and that absence is load-bearing:
   * such a token is an owner, so it is replaced rather than honoured.
   */
  seatRole?: string;
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
  status: 400 | 403 | 404 | 410 | 429 | 502;
}

export interface SeatGrant {
  computer: ComputerRecord;
  /** Revoke it the moment this request is done: it is not a seat a person keeps. */
  disposable: boolean;
  /** Store it against the invite, so a reload does not mint a second seat. */
  persist: boolean;
  role: string;
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
function resolveInvitePurpose(input: { kind?: string; purpose?: string }): string {
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
 * The screen a desk link drives. Primary is where the tenant's Bot runs, and
 * an invite has never pointed anywhere else; binding it means the phone can
 * neither name another screen nor see one in `Status`.
 */
const INVITE_DISPLAY = 1;

/** Long enough to create a Bot, write one file and delete the Bot again. */
const PLUGIN_SEAT_TTL_MS = 2 * 60_000;

interface SeatPlan {
  disposable: boolean;
  persist: boolean;
  request: SeatRequest;
}

/**
 * What each purpose is allowed to be on the hub.
 *
 * A desk link is a person on a phone, which is what `guest` names: pointer,
 * keys, presence, paste in, answer a secret request, and nothing else. It is
 * bound to the screen the link points at and expires with the link. Until
 * this, a redeemed desk link was an owner seat that never expired and could
 * drive any screen, read the clipboard, create Bots and link WhatsApp numbers.
 *
 * A plugins link authors a connection file, and there is no seat-shaped way to
 * write one: `Agent.WriteFile` takes an agent token, so the web has to
 * `CreateBot`, write, `DeleteBot` (see connection-guest.ts). That is what the
 * hub's `installer` role is: those three calls and nothing else. This used to
 * ask for an `owner` narrowed by `methods` to the same three, because `owner`
 * was the only role carrying `CreateBot`, which meant a role defined at the
 * call site and an `isOwner` that read the role rather than the narrowing.
 * The seat still lives two minutes and is still revoked as soon as the write
 * returns; what changed is that the hub, not this file, decides what it may
 * do. It is not a safe seat even so: `CreateBot` returns an agent token and
 * an agent token is `shell` on the box, which is why it is minutes long.
 */
function seatPlanFor(purpose: InvitePurpose, invite: InviteRecord, remainingMs: number): SeatPlan {
  // The subject is the invite's hash, never its token: it says which link a
  // seat came from in the owner's seat list, and it cannot be redeemed.
  const subject = `invite:${invite.tokenHash.slice(0, 12)}`;
  if (purpose === "plugins") {
    return {
      disposable: true,
      persist: false,
      request: {
        label: "hello.expert plugins invite",
        role: "installer",
        subject,
        ttlMs: Math.min(PLUGIN_SEAT_TTL_MS, remainingMs),
      },
    };
  }
  return {
    disposable: false,
    persist: true,
    request: {
      display: INVITE_DISPLAY,
      label: "hello.expert desk invite",
      role: "guest",
      subject,
      // The link's own remaining life, asked for and not clamped here. The
      // hub owns the ceiling on a guest seat; a second clamp in the web would
      // drift from it and read as though this were the one that mattered.
      ttlMs: remainingMs,
    },
  };
}

/**
 * Hand this invite a seat on its own computer, never the web server's default
 * one: the two were different machines until 2026-09-06 and may be again.
 *
 * `issue` is passed in rather than imported: the caller is what holds this
 * control plane's grant on that computer (`issueSeatAsIssuer`), and a test
 * hands in a fetch double. Nothing here can reach a setup code.
 *
 * A stored token is reused only when this control plane minted it under the
 * scoped scheme, which `seatRole` records. A record from before it carries a
 * token and no role: that token is an owner, so it is revoked and replaced on
 * the next redeem rather than handed out again.
 */
export async function grantInviteSeat(
  invite: InviteRecord,
  purpose: InvitePurpose,
  env: EnvMap,
  now: number,
  issue: IssueSeatFn,
): Promise<SeatGrant | RedeemFailure> {
  const inspected = inspectInvite(invite, purpose, env, now);
  if ("error" in inspected) {
    return inspected;
  }
  const { computer } = inspected;
  const plan = seatPlanFor(purpose, invite, invite.expiresAt - now);
  if (plan.persist && invite.seatToken && invite.seatRole === plan.request.role) {
    return {
      computer,
      disposable: false,
      persist: false,
      role: plan.request.role,
      seatToken: invite.seatToken,
    };
  }
  const issued = await issue(computer, {
    ...plan.request,
    ...(invite.seatToken ? { replaces: invite.seatToken } : {}),
  });
  if ("error" in issued) {
    return { error: issued.error, status: 502 };
  }
  return {
    computer,
    disposable: plan.disposable,
    persist: plan.persist,
    role: issued.role,
    seatToken: issued.token,
  };
}
