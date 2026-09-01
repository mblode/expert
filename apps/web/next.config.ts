import type { NextConfig } from "next";

/**
 * The hub this app talks to. In `next dev` the Seat JSON paths are rewritten
 * onto the hub so same-origin fetch works without CORS. In production the
 * Vercel server is the front door and the client calls the hub origin
 * directly (the hub now sends ACAO on JSON responses).
 */
const isDev = process.env.NODE_ENV === "development";
const HUB = process.env.HUB_URL ?? process.env.NEXT_PUBLIC_HUB_URL ?? "http://127.0.0.1:8787";
const EVE = process.env.EVE_URL ?? HUB;

const nextConfig: NextConfig = {
  reactCompiler: true,
  experimental: {
    turbopackRustReactCompiler: true,
  },
  env: {
    NEXT_PUBLIC_HUB_PROXY_TARGET: isDev ? HUB : "",
  },
  ...(isDev
    ? {
        rewrites: async () => [
          { source: "/computer.v1.Seat/:path*", destination: `${HUB}/computer.v1.Seat/:path*` },
          { source: "/eve/:path*", destination: `${EVE}/eve/:path*` },
        ],
      }
    : {}),
};

export default nextConfig;
