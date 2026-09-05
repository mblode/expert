import { timingSafeEqual } from "node:crypto";
import {
  connectionForSender,
  deliveryRecipient,
  receiveConnectionCode,
  reservedSender,
} from "@/lib/whatsapp-connection";

export const maxDuration = 120;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  const configured = process.env.EXPERT_GATEWAY_SECRET ?? "";
  const provided = request.headers.get("x-expert-gateway-secret") ?? "";
  if (
    configured.length < 32 ||
    Buffer.byteLength(provided) !== Buffer.byteLength(configured) ||
    !timingSafeEqual(Buffer.from(configured), Buffer.from(provided))
  )
    return json({ error: "Unauthorized" }, 401);
  const text = await request.text();
  if (text.length > 8 * 1024 * 1024) return json({ error: "Request too large" }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "Invalid request" }, 400);
  try {
    if (
      body.action === "delivery" &&
      typeof body.secret === "string" &&
      typeof body.acct === "string"
    ) {
      return json({ jid: (await deliveryRecipient(body.secret, body.acct)) ?? null });
    }
    const { jid } = body;
    if (typeof jid !== "string" || !/^[1-9][0-9]{7,14}@s\.whatsapp\.net$/u.test(jid))
      return json({ error: "Verified phone required" }, 400);
    if (body.action === "connect" && typeof body.code === "string") {
      const accepted = await receiveConnectionCode(body.code, jid);
      return json({
        accepted,
        reply: accepted
          ? "Phone verified. Return to Expert and confirm this number."
          : "That code has expired or cannot be used. Open Expert to get a new one.",
      });
    }
    const route = await connectionForSender(jid);
    if (body.action === "resolve")
      return json({ bound: Boolean(route) || (await reservedSender(jid)) });
    if (body.action === "message" && !route && (await reservedSender(jid)))
      return json({
        reply: "Open Expert and finish connecting this number before chatting with your assistant.",
      });
    if (body.action !== "message" || !route) return json({ error: "No connected workspace" }, 403);
    if (typeof body.messageId !== "string" || !body.messageId || typeof body.message !== "string")
      return json({ error: "Message and stable id required" }, 400);
    const response = await fetch(
      `${route.hub_url}/connectors/${encodeURIComponent(route.connector_id)}/message`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(100_000),
        headers: {
          "content-type": "application/json",
          "x-connector-secret": route.connector_secret,
        },
        // The gateway never contributes shared history or chooses the tenant,
        // account or chat token. All three follow the verified database binding.
        body: JSON.stringify({
          acct: route.acct,
          token: jid,
          sender: jid,
          senderPhone: jid.split("@")[0],
          surface: "dm",
          messageId: body.messageId,
          message: body.message,
          media: body.media,
        }),
      },
    );
    if (!response.ok) return json({ error: "Computer unavailable" }, 503);
    return json({ accepted: true }, 202);
  } catch {
    // Storage/provider exceptions can contain connector credentials.
    return json({ error: "Connection unavailable. Retry shortly." }, 503);
  }
}
