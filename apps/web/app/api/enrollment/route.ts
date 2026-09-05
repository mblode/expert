import { claimComputerEnrollment, createComputerEnrollment } from "@/lib/computer-enrollment";
import { boundComputerId, isComputerOperator } from "@/lib/computers";
import { getSessionCached } from "@/lib/session";

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return Response.json({ error: "Open setup on this site and try again." }, { status: 403 });
  const session = await getSessionCached();
  if (!session?.user?.id) return Response.json({ error: "Sign in first." }, { status: 401 });
  const text = await request.text();
  if (text.length > 4096)
    return Response.json({ error: "Setup request is too large." }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid setup request." }, { status: 400 });
  }
  if (!body || typeof body !== "object")
    return Response.json({ error: "Invalid setup request." }, { status: 400 });
  if (body.action === "invite") {
    if (!isComputerOperator(session.user.email, process.env))
      return Response.json({ error: "Not allowed." }, { status: 403 });
    const { email, hubUrl, label, setupCode } = body;
    if ([email, hubUrl, label, setupCode].some((value) => typeof value !== "string"))
      return Response.json({ error: "Complete all invitation fields." }, { status: 400 });
    try {
      const result = await createComputerEnrollment({
        createdBy: session.user.id,
        email: email as string,
        hubUrl: hubUrl as string,
        label: label as string,
        setupCode: setupCode as string,
      });
      return Response.json(
        {
          url: `${new URL(request.url).origin}/start?invite=${result.token}`,
          expiresAt: result.expiresAt,
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch {
      // Database errors may include the inserted credential. Never reflect them.
      return Response.json(
        {
          error:
            "Could not create the invitation. Check the fields and whether this computer has already been registered.",
        },
        { status: 400 },
      );
    }
  }
  if (body.action !== "claim" || typeof body.token !== "string")
    return Response.json({ error: "Open your setup invitation." }, { status: 400 });
  if (boundComputerId(session.user.email, process.env))
    return Response.json({ error: "This account already has a computer." }, { status: 409 });
  const claimed = await claimComputerEnrollment({
    token: body.token,
    userId: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
  });
  return claimed
    ? Response.json({ claimed: true }, { headers: { "cache-control": "no-store" } })
    : Response.json(
        {
          error:
            "This invitation is expired, already claimed, or belongs to a different email. Sign in with the invited address.",
        },
        { status: 403 },
      );
}
