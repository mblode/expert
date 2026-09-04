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
    let sock: ReturnType<typeof createConnection> | undefined;
    let done = false;
    // A viewer watching a screen is using it, so a long look does not end with
    // the window swept out from under them.
    const watching = setInterval(() => {
      void opts.use?.(screen).catch(() => {
        // The sweep decides; a failed touch is not worth closing a session for.
      });
    }, WATCH_TOUCH_MS);
    watching.unref();
    const finish = (): void => {
      done = true;
      clearInterval(watching);
      sock?.destroy();
      ws.close();
    };
    ws.on("close", () => {
      done = true;
      clearInterval(watching);
      sock?.destroy();
    });
    // Attached once, not per dial: RFB is server-speaks-first, so nothing has
    // arrived yet, and a listener per retry would write every frame twice.
    ws.on("message", (d) => {
      // ws delivers Buffer | ArrayBuffer | Buffer[]; a fragmented frame
      // arrives as the array and must be joined, not passed to Buffer.from().
      if (Buffer.isBuffer(d)) {
        sock?.write(d);
      } else if (Array.isArray(d)) {
        sock?.write(Buffer.concat(d));
      } else {
        sock?.write(Buffer.from(d));
      }
    });
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

    /**
     * Dial x11vnc, retrying a connect that was refused.
     *
     * `start-window` waits for the X server, not for x11vnc, which comes up a
     * moment later, so on a screen that was just claimed the first connect
     * loses the race. Closing the socket there would make waking a sleeping
     * Bot's desk look broken to the person who asked for it. A connection
     * that came up and then closed is the box saying the session ended, and
     * that is not retried.
     */
    function dial(attempt = 0): void {
      if (done || ws.readyState !== ws.OPEN) {
        return;
      }
      const next = createConnection({ host: opts.host, port: opts.basePort + screen });
      sock = next;
      let connected = false;
      next.on("connect", () => {
        connected = true;
      });
      // Handled on "close", which always follows: retrying here as well would
      // dial twice for one failure.
      next.on("error", () => undefined);
      next.on("data", (d) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(d);
        }
      });
      next.on("close", () => {
        if (connected || done || attempt >= DIAL_ATTEMPTS) {
          finish();
          return;
        }
        setTimeout(() => dial(attempt + 1), DIAL_RETRY_MS).unref();
      });
    }
  });
}

/** How often a live viewer counts as using the screen it is watching. */
const WATCH_TOUCH_MS = 60_000;
/** x11vnc is a second behind the X server on a screen that was just claimed. */
const DIAL_ATTEMPTS = 8;
const DIAL_RETRY_MS = 250;

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
