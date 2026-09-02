import { isComputerOperator } from "./computers";

/** Header the invite pages send. The token is never logged here. */
export const INVITE_HEADER = "x-computer-invite";

export function inviteTokenFromRequest(request: Request, body?: unknown): string {
  const header = request.headers.get(INVITE_HEADER)?.trim();
  if (header) {
    return header;
  }
  if (body && typeof body === "object" && "invite" in body && typeof body.invite === "string") {
    return body.invite.trim();
  }
  return "";
}

export function canMintInvite(request: Request, email: string | undefined): boolean {
  const secret = process.env.INVITE_MINT_SECRET;
  const bearer = request.headers.get("authorization");
  if (secret && bearer === `Bearer ${secret}`) {
    return true;
  }
  return Boolean(email && isComputerOperator(email, process.env));
}
