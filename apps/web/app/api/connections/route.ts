import { after } from "next/server";

import { revokeSeat } from "@/lib/computers";
import { writeConnectionFile } from "@/lib/connection-guest";
import { installConnection } from "@/lib/connection-install";
import { inviteTokenFromRequest } from "@/lib/invite-access";
import { loadStoredInvite, redeemStoredInvite } from "@/lib/invite-store";
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
  const granted = await redeemStoredInvite(token, "plugins");
  if ("error" in granted) {
    return Response.json({ error: granted.error }, { status: granted.status });
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
  try {
    const result = await installConnection({
      authKind: typeof input.authKind === "string" ? input.authKind : undefined,
      credential: typeof input.credential === "string" ? input.credential : undefined,
      name: typeof input.name === "string" ? input.name : undefined,
      url: typeof input.url === "string" ? input.url : undefined,
      write: (path, source) =>
        writeConnectionFile({
          hubUrl: granted.hubUrl,
          path,
          seatToken: granted.seatToken,
          source,
        }),
    });
    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status });
    }
    // Awaited, this held the install response behind a two-second analytics
    // flush and delayed the `finally` that ends the plugins seat.
    after(() =>
      captureServerEvent({
        distinctId: distinctIdFromRequest(request, granted.computerId),
        event: "plugin_added",
        properties: {
          auth_kind: result.plugin.authKind,
          computer_id: granted.computerId,
          installed: result.installed,
          source: "invite",
        },
      }),
    );
    return Response.json(result);
  } finally {
    // The plugins seat exists to write one file. It expires on its own in
    // minutes; ending it here means a leaked response or a stalled tab cannot
    // spend the rest of that window.
    if (granted.disposable) {
      await revokeSeat(granted.computer, granted.seatToken);
    }
  }
}
