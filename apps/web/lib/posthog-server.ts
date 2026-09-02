import { PostHog } from "posthog-node";

/**
 * Per-request client: Vercel functions can freeze before a long-lived queue
 * flushes. Callers must shutdown() this instance; do not reuse it.
 */
function createPostHogClient(): PostHog | null {
  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (!token) {
    return null;
  }
  return new PostHog(token, {
    flushAt: 1,
    flushInterval: 0,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  });
}

export function distinctIdFromRequest(request: Request, fallback: string): string {
  return request.headers.get("x-posthog-distinct-id") ?? fallback;
}

export function sessionPropertiesFromRequest(request: Request): Record<string, unknown> {
  const sessionId = request.headers.get("x-posthog-session-id");
  return sessionId ? { $session_id: sessionId } : {};
}

export async function captureServerEvent({
  distinctId,
  event,
  properties,
}: {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}): Promise<void> {
  const client = createPostHogClient();
  if (!client || !distinctId) {
    return;
  }
  try {
    client.capture({ distinctId, event, properties });
    await client.shutdown(2000);
  } catch {
    // Analytics must never fail sign-in or pairing.
  }
}
