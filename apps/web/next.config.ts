import type { NextConfig } from "next";

/**
 * The hub this app talks to.
 *
 * `next dev` proxies JSON onto HUB_URL. A hub-served export is same-origin
 * (no NEXT_PUBLIC_HUB_URL). A Vercel export sets NEXT_PUBLIC_HUB_URL to the
 * Fly computer; pixels stay on that origin via the minted `vnc_url`.
 */
const isDev = process.env.NODE_ENV === "development";
const HUB = process.env.HUB_URL ?? "http://127.0.0.1:8787";
const EVE = process.env.EVE_URL ?? HUB;

const nextConfig: NextConfig = {
  // Static files only — no Next server. The hub may serve `out/`, or Vercel
  // publishes the same directory. The desk never runs here.
  output: "export",
  reactCompiler: true,
  experimental: {
    // React Compiler inside Turbopack rather than Babel.
    turbopackRustReactCompiler: true,
  },
  env: {
    // Inlined at build time. Empty unless `next dev` is proxying the hub.
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
