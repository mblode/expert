import { after } from "next/server";

import { revokeSeat } from "@/lib/computers";
import { writeConnectionFile } from "@/lib/connection-guest";
import { installConnection } from "@/lib/connection-install";
import { inviteTokenFromRequest } from "@/lib/invite-access";
import { loadStoredInvite, redeemStoredInvite } from "@/lib/invite-store";
import { captureServerEvent, distinctIdFromRequest } from "@/lib/posthog-server";
import { getSessionCached } from "@/lib/session";

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
  // Cookie authority is accepted only from our own origin; link parameters
  // never choose the hub or provide a credential on the owner path.
  const session = token ? null : await getSessionCached();
  if (!token && request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Open plugin setup on this site." }, { status: 403 });
  }
  const granted =
    session?.seatToken && session.hubUrl
      ? {
          computerId: session.computerId,
          hubUrl: session.hubUrl,
          seatToken: session.seatToken,
          disposable: false,
        }
      : await redeemStoredInvite(token, "plugins");
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
          bot?: unknown;
        })
      : {};
  const bot = "bot" in input && typeof input.bot === "string" ? input.bot : "main";
  if (!token && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(bot)) {
    return Response.json({ error: "Select a valid assistant." }, { status: 400 });
  }
  if (!token) {
    const roster = await fetch(`${granted.hubUrl}/roster`, {
      headers: { authorization: `Bearer ${granted.seatToken}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const payload = (await roster?.json().catch(() => null)) as { bots?: { id: string }[] } | null;
    if (!roster?.ok || !payload?.bots?.some((row) => row.id === bot)) {
      return Response.json(
        { error: "This assistant is not available on your computer." },
        { status: 403 },
      );
    }
  }
  try {
    const result = await installConnection({
      authKind: typeof input.authKind === "string" ? input.authKind : undefined,
      credential: typeof input.credential === "string" ? input.credential : undefined,
      name: typeof input.name === "string" ? input.name : undefined,
      url: typeof input.url === "string" ? input.url : undefined,
      write: (path, source) =>
        writeConnectionFile({
          hubUrl: granted.hubUrl,
          path: token
            ? path
            : `/workspace/eve/bots/${bot}/agent/connections/${path.split("/").at(-1)}`,
          seatToken: granted.seatToken,
          source,
        }),
    });
    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status });
    }
    if (!token) {
      result.plugin.path = `/workspace/eve/bots/${bot}/agent/connections/${result.plugin.filename}`;
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
          source: token ? "invite" : "owner",
        },
      }),
    );
    return Response.json(result);
  } finally {
    // The plugins seat exists to write one file. It expires on its own in
    // minutes; ending it here means a leaked response or a stalled tab cannot
    // spend the rest of that window.
    if (granted.disposable && "computer" in granted) {
      await revokeSeat(granted.computer, granted.seatToken);
    }
  }
}
