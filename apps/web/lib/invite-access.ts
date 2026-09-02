import { isComputerOperator } from "./computers";

/** Header the invite pages send. The token is never logged here. */
export const INVITE_HEADER = "x-computer-invite";

export function inviteTokenFromRequest(request: Request): string {
  return request.headers.get(INVITE_HEADER)?.trim() ?? "";
}

export function canMintInvite(request: Request, email: string | undefined): boolean {
  const secret = process.env.INVITE_MINT_SECRET;
  const bearer = request.headers.get("authorization");
  if (secret && bearer === `Bearer ${secret}`) {
    return true;
  }
  return Boolean(email && isComputerOperator(email, process.env));
}
