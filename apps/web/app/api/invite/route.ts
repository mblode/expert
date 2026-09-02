import { respondToInviteMint } from "@/lib/invite-mint";
import { getSessionCached } from "@/lib/session";

export async function POST(request: Request): Promise<Response> {
  const session = await getSessionCached();
  return respondToInviteMint(request, session?.user?.email);
}
