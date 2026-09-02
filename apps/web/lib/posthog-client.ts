import { posthog } from "posthog-js";

function enabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN);
}

export function identifyUser(userId: string, email?: string | null): void {
  if (!enabled() || !userId) {
    return;
  }
  posthog.identify(userId, email ? { email } : undefined);
}

export function resetPostHog(): void {
  if (!enabled()) {
    return;
  }
  posthog.reset();
}

export function captureEvent(event: string, properties?: Record<string, unknown>): void {
  if (!enabled()) {
    return;
  }
  posthog.capture(event, properties);
}

export function captureClientException(error: unknown): void {
  if (!enabled()) {
    return;
  }
  posthog.captureException(error);
}

/** Forward the browser person and session so a server capture can join this replay. */
export function posthogForwardHeaders(): Record<string, string> {
  if (!enabled()) {
    return {};
  }
  const distinctId = posthog.get_distinct_id();
  const sessionId = posthog.get_session_id();
  const headers: Record<string, string> = {};
  if (distinctId) {
    headers["X-POSTHOG-DISTINCT-ID"] = distinctId;
  }
  if (sessionId) {
    headers["X-POSTHOG-SESSION-ID"] = sessionId;
  }
  return headers;
}
