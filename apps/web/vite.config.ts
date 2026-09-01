import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The hub the dev server proxies to. The app talks to same-origin paths in
 * dev because the hub answers the CORS preflight but does not echo
 * `access-control-allow-origin` on the responses themselves — a browser on
 * another origin cannot read them. See `apiBase` in src/lib/seat.ts.
 */
const HUB = process.env.HUB_URL ?? "http://127.0.0.1:8787";

/**
 * Where `/eve/v1/*` goes. The hub proxies Eve, so this defaults to the hub;
 * point it at `eve dev` directly while that proxy is not mounted yet:
 *   EVE_URL=http://127.0.0.1:2000 npm run web
 */
const EVE = process.env.EVE_URL ?? HUB;

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  // Only a dev server has the proxy, so a build must always use absolute URLs.
  define: { __HUB_PROXY_TARGET__: JSON.stringify(command === "serve" ? HUB : "") },
  server: {
    proxy: {
      "/computer.v1.Seat": HUB,
      // noVNC page, its assets, and the RFB websocket it opens back to us.
      "/vnc": HUB,
      "/novnc": HUB,
      "/websockify": { target: HUB, ws: true },
      "/eve": EVE,
    },
  },
}));
