import { canMintInvite } from "@/lib/invite-access";
import { mintStoredInvite } from "@/lib/invite-store";
import { getSessionCached } from "@/lib/session";

export async function POST(request: Request): Promise<Response> {
  const session = await getSessionCached();
  if (!canMintInvite(request, session?.user?.email)) {
    return Response.json({ error: "Not allowed to mint an invite." }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  const input =
    body && typeof body === "object"
      ? (body as {
          computerId?: unknown;
          purpose?: unknown;
          sender?: unknown;
          ttlMinutes?: unknown;
        })
      : {};
  const minted = await mintStoredInvite(
    {
      computerId: typeof input.computerId === "string" ? input.computerId : undefined,
      purpose: typeof input.purpose === "string" ? input.purpose : undefined,
      sender: typeof input.sender === "string" ? input.sender : undefined,
      ttlMinutes: typeof input.ttlMinutes === "number" ? input.ttlMinutes : undefined,
    },
    request,
  );
  if ("error" in minted) {
    return Response.json({ error: minted.error }, { status: minted.status });
  }
  return Response.json(minted);
}
