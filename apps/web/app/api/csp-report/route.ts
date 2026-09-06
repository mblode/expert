/**
 * Where the report-only Content-Security-Policy sends violations. Logged,
 * not stored: the point is to read what the real app trips before the
 * policy is enforced, and Vercel's function logs are enough for that. Body
 * is bounded and never echoed.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await request.text().catch(() => "");
  const text = raw.slice(0, 4096);
  let summary = text;
  try {
    const body = JSON.parse(text) as { "csp-report"?: Record<string, unknown> };
    const r = body["csp-report"];
    if (r) {
      summary = `${String(r["violated-directive"] ?? r.effectiveDirective ?? "?")} blocked ${String(r["blocked-uri"] ?? r.blockedURL ?? "?")} on ${String(r["document-uri"] ?? r.documentURL ?? "?")}`;
    }
  } catch {
    // Not JSON; the raw text is the summary.
  }
  console.warn(`[csp-report] ${summary}`);
  return new Response(null, { status: 204 });
}
