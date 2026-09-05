import { after } from "next/server";

import { refreshComputerSeat } from "@/lib/computer-seat";
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
  const seat = await refreshComputerSeat(session.user.id, session.user.email);
  if (seat.seatError || !seat.seatToken) {
    return Response.json(
      { error: seat.seatError ?? "Could not attach to the computer." },
      { status: 502 },
    );
  }
  // The PostHog client is flushed with `shutdown(2000)`, so awaiting this put
  // up to two seconds of analytics in front of the seat the browser is waiting
  // on, and this is the call the workspace makes when the hub has already
  // rejected its seat. The properties are read here, while the request is
  // live; only the send waits for the response to go out.
  const capture = {
    distinctId: distinctIdFromRequest(request, session.user.id),
    event: "computer_reconnected",
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
