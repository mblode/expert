import { completeOnboarding } from "@/lib/onboarding-store";
import {
  captureServerEvent,
  distinctIdFromRequest,
  sessionPropertiesFromRequest,
} from "@/lib/posthog-server";
import { getSessionCached } from "@/lib/session";

/**
 * Finish the first run for the signed-in user.
 *
 * The body is one field and it is filtered rather than rejected
 * (`keepTools`): the answer is a preference, and a client that sent an id this
 * build does not list should still get its owner past the first run.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getSessionCached();
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  const asked = body && typeof body === "object" && "tools" in body ? body.tools : [];
  const tools = await completeOnboarding(session.user.id, asked);
  await captureServerEvent({
    distinctId: distinctIdFromRequest(request, session.user.id),
    event: "onboarding_completed",
    properties: {
      source: "server",
      tool_count: tools.length,
      tools,
      ...sessionPropertiesFromRequest(request),
    },
  });
  return Response.json({ tools });
}
