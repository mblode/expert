import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { pageMarkdown } from "@/lib/pages";

/**
 * Content negotiation for agents: a public page asked for with
 * `Accept: text/markdown` gets its Markdown twin. Built as a Response here
 * rather than rewritten to a route, because Next replaces `Vary` on App
 * Router HTML responses and the `Vary: Accept` has to survive. The twin is
 * `noindex`: the HTML page is the canonical one.
 */
export function proxy(request: NextRequest): NextResponse | Response {
  const accept = request.headers.get("accept") ?? "";
  if (request.method === "GET" && /\btext\/markdown\b/u.test(accept)) {
    const body = pageMarkdown(request.nextUrl.pathname);
    if (body !== null) {
      return new Response(body, {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": "text/markdown; charset=utf-8",
          vary: "Accept",
          "x-robots-tag": "noindex",
        },
      });
    }
  }
  return NextResponse.next();
}

// A literal, because Next reads it statically. Anchored at both ends: every
// negotiable path is listed, plus one segment under /guides. Keep in step
// with MARKDOWN_PATHS in lib/pages.ts; the test there covers the content side.
export const config = {
  matcher: ["/", "/about", "/contact", "/privacy", "/guides", "/guides/:slug"],
};
