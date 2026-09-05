import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { phoneClockTargets } from "@/lib/phone-account";
import { provisionNextPhone } from "@/lib/phone-provision";

export const maxDuration = 120;
export async function POST(request: Request) {
  const expected = process.env.EXPERT_PROVISION_SECRET ?? "";
  const received = request.headers.get("x-provision-secret") ?? "";
  if (
    expected.length < 32 ||
    Buffer.byteLength(expected) !== Buffer.byteLength(received) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(received))
  )
    return new Response(null, { status: 401 });
  after(provisionNextPhone);
  return Response.json(
    { targets: await phoneClockTargets() },
    { headers: { "cache-control": "no-store" } },
  );
}
