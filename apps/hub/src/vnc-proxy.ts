import { createConnection } from "node:net";
import type { IncomingMessage } from "node:http";
import { MAX_DISPLAYS, PRIMARY_DISPLAY } from "@computer/shared";
import type { WebSocket, WebSocketServer } from "ws";
import type { AuthRegistry } from "./handler/auth.ts";
import { tokenFromRequest } from "./handler/auth.ts";

/**
 * websockify: noVNC talks RFC6455; x11vnc talks raw RFB on 5900+N
 * (localhost, view-only). `?display=N` selects the window (default primary).
 * Pixel or seat token required (query `token` or Authorization).
 * Inside the guest, noVNC also listens on 6080 / 6081+ (Grok ports).
 */
export function attachVncProxy(
  wss: WebSocketServer,
  opts: {
    host: string;
    basePort: number;
    auth: AuthRegistry;
    hasDisplay: (display: number) => boolean;
    /** Bring this screen up before dialling it, and keep it up while watched. */
    use?: (display: number) => Promise<void>;
  },
): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const token = tokenFromRequest(req);
    if (!opts.auth.canViewPixels(token)) {
      ws.close(4401, "unauthenticated");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/websockify" && url.pathname !== "/vnc/websockify") {
      ws.close();
      return;
    }
    const display = parseDisplayParam(url.searchParams.get("display"));
    if (display === null || !opts.hasDisplay(display)) {
      ws.close(4404, "unknown display");
      return;
    }
    // A pixel grant is minted for one screen; a seat token may view any.
    const grant = opts.auth.pixels.lookup(token);
    if (grant && grant.display !== display) {
      ws.close(4403, "token is for another display");
      return;
    }
    // Bring the screen up first. x11vnc is not listening on a display whose
    // window was released for being idle, and a viewer must not be the one
    // thing that cannot wake a Bot's screen.
    const screen = display;
    void (opts.use?.(screen) ?? Promise.resolve())
      .catch(() => {
        // Fall through to the dial: the window may be up anyway, and a
        // refused connection is a clearer failure than a silent close.
      })
      .then(() => {
        if (ws.readyState !== ws.OPEN && ws.readyState !== ws.CONNECTING) {
          return;
        }
        dial();
      });

    function dial(): void {
      const sock = createConnection({ host: opts.host, port: opts.basePort + screen });
      sock.on("error", () => ws.close());
      sock.on("data", (d) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(d);
        }
      });
      sock.on("close", () => ws.close());
      // A viewer watching a screen is using it, so a long look does not end
      // with the window swept out from under them.
      const watching = setInterval(() => {
        void opts.use?.(screen).catch(() => {
          /* the sweep will decide; a failed touch is not fatal */
        });
      }, WATCH_TOUCH_MS);
      watching.unref();
      sock.on("close", () => clearInterval(watching));
      ws.on("close", () => {
        clearInterval(watching);
        sock.destroy();
      });
      ws.on("message", (d) => {
        // ws delivers Buffer | ArrayBuffer | Buffer[]; a fragmented frame
        // arrives as the array and must be joined, not passed to Buffer.from().
        if (Buffer.isBuffer(d)) {
          sock.write(d);
        } else if (Array.isArray(d)) {
          sock.write(Buffer.concat(d));
        } else {
          sock.write(Buffer.from(d));
        }
      });
    }
  });
}

/** How often a live viewer counts as using the screen it is watching. */
const WATCH_TOUCH_MS = 60_000;

function parseDisplayParam(v: string | null): number | null {
  if (v === null || v === "") {
    return PRIMARY_DISPLAY;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DISPLAYS) {
    return null;
  }
  return n;
}
