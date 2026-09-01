import type { NextConfig } from "next";

/**
 * The hub this app talks to. Same-origin in production — the hub serves the
 * exported build itself — so this only matters to `next dev`.
 */
const isDev = process.env.NODE_ENV === "development";
const HUB = process.env.HUB_URL ?? "http://127.0.0.1:8787";
const EVE = process.env.EVE_URL ?? HUB;

const nextConfig: NextConfig = {
  // A client-only control panel for a box on your own machine. There is no
  // server to render on and nothing to host: `next build` emits static files
  // the hub serves from its own origin, which keeps the hub's loopback bind
  // the only listening socket.
  output: "export",
  reactCompiler: true,
  experimental: {
    // React Compiler inside Turbopack rather than Babel.
    turbopackRustReactCompiler: true,
  },
  env: {
    // Inlined at build time. Empty in an export build: there is no proxy, and
    // same-origin is the whole point of the hub serving these files.
    NEXT_PUBLIC_HUB_PROXY_TARGET: isDev ? HUB : "",
  },
  /**
   * Dev only, and the key itself is omitted in a build: `output: "export"`
   * warns whenever `rewrites` is merely present, whatever it returns.
   *
   * Deliberately just the two JSON/stream paths. `/vnc`, `/novnc` and
   * `/websockify` are NOT proxied, because a Next rewrite cannot carry a
   * WebSocket upgrade and noVNC opens one back to `location.host`. The hub
   * mints absolute `vnc_url`s, so the desktop iframe loads straight from the
   * hub and its socket stays same-origin with it.
   */
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
