import { inviteTokenFromRequest } from "@/lib/invite-access";
import { refreshStoredInvite } from "@/lib/invite-store";

export async function POST(request: Request): Promise<Response> {
  const token = inviteTokenFromRequest(request);
  const granted = await refreshStoredInvite(token, "desk");
  if ("error" in granted) {
    return Response.json({ error: granted.error }, { status: granted.status });
  }
  return Response.json({
    computerId: granted.computerId,
    hubUrl: granted.hubUrl,
    seatToken: granted.seatToken,
  });
}
