import type { WhatsAppConnectResponse } from "@/lib/whatsapp-connection";
import { getSessionCached } from "@/lib/session";
import { accountComputers } from "@/lib/computer-seat";
import { confirmConnection, connectionStatus, startConnection } from "@/lib/whatsapp-connection";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
export async function GET() {
  const session = await getSessionCached();
  if (!session?.user?.id) return json({ error: "Sign in first." }, 401);
  return json({
    connection: await connectionStatus(session.user.id),
    available: Boolean(process.env.EXPERT_WHATSAPP_NUMBER && process.env.EXPERT_GATEWAY_SECRET),
  });
}

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return json({ error: "Open setup on this site." }, 403);
  const session = await getSessionCached();
  if (!session?.user?.id || !session.seatToken)
    return json({ error: "Connect your workspace first." }, 401);
  const number = process.env.EXPERT_WHATSAPP_NUMBER;
  if (!number || !/^[1-9][0-9]{7,14}$/u.test(number) || !process.env.EXPERT_GATEWAY_SECRET)
    return json({ error: "WhatsApp setup is not available yet." }, 503);
  const catalog = await accountComputers(session.user.id, session.user.email);
  if (!catalog.some((record) => record.hubUrl === session.hubUrl))
    return json({ error: "Workspace access required." }, 403);
  const text = await request.text();
  if (text.length > 1024) return json({ error: "Request too large." }, 413);
  let body: { action?: string; phone?: string } | null;
  try {
    body = JSON.parse(text || "null");
  } catch {
    return json({ error: "Invalid setup request." }, 400);
  }
  const call = async (action: string, jid?: string): Promise<WhatsAppConnectResponse> => {
    const response = await fetch(`${session.hubUrl}/computer.v1.Seat/WhatsAppConnect`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${session.seatToken}`, "content-type": "application/json" },
      body: JSON.stringify({ action, jid }),
    });
    if (!response.ok) throw new Error("Computer setup is unavailable");
    return response.json();
  };
  try {
    if (body?.action === "start") {
      const credentials = await call("prepare");
      const code = await startConnection(session.user.id, session.hubUrl, credentials);
      return json({ url: `https://wa.me/${number}?text=${encodeURIComponent(`connect ${code}`)}` });
    }
    if (body?.action === "confirm" && typeof body.phone === "string") {
      await confirmConnection(session.user.id, body.phone, async (row) => {
        if (row.hub_url !== session.hubUrl) throw new Error("Workspace mismatch");
        await call("bind", row.jid!);
      });
      return json({ connected: true });
    }
    return json({ error: "Choose a setup action." }, 400);
  } catch {
    return json({ error: "Could not connect yet. Check the phone number and retry." }, 409);
  }
}
