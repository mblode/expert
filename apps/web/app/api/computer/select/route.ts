import { after } from "next/server";

import { bindComputerSeat } from "@/lib/computer-seat";
import {
  captureServerEvent,
  distinctIdFromRequest,
  sessionPropertiesFromRequest,
} from "@/lib/posthog-server";
import { getSessionCached } from "@/lib/session";

export async function POST(request: Request): Promise<Response> {
  const session = await getSessionCached();
  if (!session?.user?.id || !session.user.email) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  const computerId =
    body && typeof body === "object" && "computerId" in body && typeof body.computerId === "string"
      ? body.computerId.trim()
      : "";
  if (!computerId) {
    return Response.json({ error: "Choose a computer." }, { status: 400 });
  }
  const seat = await bindComputerSeat(session.user.id, session.user.email, computerId);
  if (seat.seatError || !seat.seatToken) {
    return Response.json(
      { error: seat.seatError ?? "Could not attach to the computer." },
      { status: seat.denied ? 403 : 502 },
    );
  }
  // Same flush as reconnect: two seconds of analytics ahead of the seat the
  // browser is blocked on, so it goes after the response instead.
  const capture = {
    distinctId: distinctIdFromRequest(request, session.user.id),
    event: "computer_connected",
    properties: {
      computer_id: seat.computerId,
      source: "server",
      ...sessionPropertiesFromRequest(request),
    },
  };
  after(() => captureServerEvent(capture));
  return Response.json({
    computerId: seat.computerId,
    hubUrl: seat.hubUrl,
    seatToken: seat.seatToken,
  });
}
