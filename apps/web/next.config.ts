import type { NextConfig } from "next";

/**
 * The hub this app talks to. In `next dev` the Seat JSON and Eve paths are
 * rewritten onto the hub so same-origin fetch works without CORS. In
 * production the Vercel server is the front door and the client calls the hub
 * origin directly (the hub sends ACAO on JSON responses).
 */
const isDev = process.env.NODE_ENV === "development";
const HUB = process.env.HUB_URL ?? process.env.NEXT_PUBLIC_HUB_URL ?? "http://127.0.0.1:8787";

/** Static hardening for a site that carries an auth cookie and frames a remote desktop. */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // The one CSP directive that is safe to enforce without a report-only
  // rollout. A full policy needs the hub origin, its WebSockets, Vercel Blob
  // and PostHog enumerated and watched in report-only first; that is a
  // separate change. `X-Frame-Options: DENY` above says the same thing to
  // older browsers.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_HUB_PROXY_TARGET: isDev ? HUB : "",
  },
  experimental: {
    // Eighteen files import named icons from this package's root, and it is
    // not on Next's built-in list, so without this the whole barrel is pulled
    // in at each import site, in dev and in the trace. Next rewrites them to
    // per-icon paths at build time and the named-export types stay.
    optimizePackageImports: ["blode-icons-react"],
    turbopackRustReactCompiler: true,
  },
  headers: async () => [{ source: "/:path*", headers: securityHeaders }],
  poweredByHeader: false,
  reactCompiler: true,
  ...(isDev
    ? {
        rewrites: async () => [
          { destination: `${HUB}/computer.v1.Seat/:path*`, source: "/computer.v1.Seat/:path*" },
          { destination: `${HUB}/eve/:path*`, source: "/eve/:path*" },
          // `/roster` is the one owner route that is a plain GET rather than an
          // RPC under the Seat prefix, so it needs its own line. Without it the
          // Bot profiles 404 against Next in `next dev` and every Bot silently
          // falls back to its id and a hashed mark, which looks like the
          // settings never saved rather than like a missing proxy rule.
          { destination: `${HUB}/roster`, source: "/roster" },
        ],
      }
    : {}),
};

export default nextConfig;
