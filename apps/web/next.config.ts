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
];

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_HUB_PROXY_TARGET: isDev ? HUB : "",
  },
  experimental: {
    turbopackRustReactCompiler: true,
  },
  headers: async () => [{ source: "/(.*)", headers: securityHeaders }],
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
