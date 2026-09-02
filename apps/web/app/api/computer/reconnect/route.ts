import { refreshComputerSeat } from "@/lib/computer-seat";
import { getSessionCached } from "@/lib/session";

export async function POST(): Promise<Response> {
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
  return Response.json({ hubUrl: seat.hubUrl, seatToken: seat.seatToken });
}
