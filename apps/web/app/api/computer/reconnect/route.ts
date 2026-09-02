import { refreshComputerSeat } from "@/lib/computer-seat";
import {
  captureServerEvent,
  distinctIdFromRequest,
  sessionPropertiesFromRequest,
} from "@/lib/posthog-server";
import { getSessionCached } from "@/lib/session";

export async function POST(request: Request): Promise<Response> {
  const session = await getSessionCached();
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const seat = await refreshComputerSeat(session.user.id);
  if (seat.seatError || !seat.seatToken) {
    return Response.json(
      { error: seat.seatError ?? "Could not attach to the computer." },
      { status: 502 },
    );
  }
  await captureServerEvent({
    distinctId: distinctIdFromRequest(request, session.user.id),
    event: "computer_reconnected",
    properties: { source: "server", ...sessionPropertiesFromRequest(request) },
  });
  return Response.json({ hubUrl: seat.hubUrl, seatToken: seat.seatToken });
}
