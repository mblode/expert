import { requestAccess } from "@/lib/waitlist";

/**
 * Public: the sign-in form calls this before asking for a code, and a
 * marketing form may call it directly. The answer says only whether this
 * address may sign in or has been put on the list; it never says who else is
 * on either. Bounded per instance so one address cannot be used to make the
 * outbox send in a loop; the store is idempotent per address regardless.
 */
const WINDOW_MS = 60_000;
const PER_WINDOW = 20;
const seen = new Map<string, { count: number; until: number }>();

function limited(key: string, now = Date.now()): boolean {
  const entry = seen.get(key);
  if (!entry || entry.until < now) {
    seen.set(key, { count: 1, until: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > PER_WINDOW;
}

export async function POST(request: Request): Promise<Response> {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (limited(ip)) {
    return Response.json({ error: "Too many requests. Try again in a minute." }, { status: 429 });
  }
  const body: unknown = await request.json().catch(() => null);
  const email = body && typeof body === "object" && "email" in body ? body.email : undefined;
  const source =
    body && typeof body === "object" && "source" in body && typeof body.source === "string"
      ? body.source.slice(0, 32)
      : "login";
  const decision = await requestAccess({ email, source });
  if (decision.status === "invalid") {
    return Response.json({ error: decision.error }, { status: 400 });
  }
  return Response.json(decision);
}
