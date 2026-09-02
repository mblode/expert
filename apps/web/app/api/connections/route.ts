import { installConnection } from "@/lib/connection-install";
import { inviteTokenFromRequest } from "@/lib/invite-access";
import { loadStoredInvite } from "@/lib/invite-store";
import { captureServerEvent, distinctIdFromRequest } from "@/lib/posthog-server";

export async function GET(request: Request): Promise<Response> {
  const token = inviteTokenFromRequest(request);
  const loaded = await loadStoredInvite(token, "plugins");
  if ("error" in loaded) {
    return Response.json({ error: loaded.error }, { status: loaded.status });
  }
  // Guest directory listing is not wired yet. The durable list is
  // agent/connections/*.ts on the computer, not this response.
  return Response.json({ computerId: loaded.computerId, plugins: [] });
}

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const token = inviteTokenFromRequest(request, body);
  const loaded = await loadStoredInvite(token, "plugins");
  if ("error" in loaded) {
    return Response.json({ error: loaded.error }, { status: loaded.status });
  }
  const input =
    body && typeof body === "object"
      ? (body as {
          authKind?: unknown;
          credential?: unknown;
          name?: unknown;
          url?: unknown;
        })
      : {};
  const result = await installConnection({
    authKind: typeof input.authKind === "string" ? input.authKind : undefined,
    credential: typeof input.credential === "string" ? input.credential : undefined,
    name: typeof input.name === "string" ? input.name : undefined,
    url: typeof input.url === "string" ? input.url : undefined,
  });
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  await captureServerEvent({
    distinctId: distinctIdFromRequest(request, loaded.computerId),
    event: "plugin_added",
    properties: {
      auth_kind: result.plugin.authKind,
      computer_id: loaded.computerId,
      installed: result.installed,
      source: "invite",
    },
  });
  return Response.json(result);
}
