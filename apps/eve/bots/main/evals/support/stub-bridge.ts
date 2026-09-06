import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A canned stand-in for the Baileys bridge, on an ephemeral port.
 *
 * Half the agent degrades without a bridge: `bridgeConfigured()` is false in an
 * eval, so `get-recent-messages`, `get-reactions`, `get-shared-resources`,
 * `audit-memory`'s deep scan, `runConsolidation` and the digest all return
 * `{ available: false }` and nothing downstream of them is testable. Point
 * `BRIDGE_URL` here and they all take their real path against fixed data.
 *
 * Deliberately standalone — `bridge/` is a separate tsconfig and its server
 * pulls in Baileys. This mirrors the shape of `bridge/send-idempotency.test.ts`
 * without importing from it.
 */

/** A message row in the shape `/messages` serves (`agent/lib/live-tail.ts`). */
export interface StubMessage {
  /** Unix seconds. */
  t: number;
  /** Sender user-part. */
  s: string;
  /** Display name, or null when the bridge never resolved one. */
  n: string | null;
  /** Message text. */
  x: string;
  /** WhatsApp message id; reactions join to this. */
  id?: string;
}

/** A reaction row in the shape `/reactions` serves (`agent/lib/reactions.ts`). */
export interface StubReaction {
  t: number;
  s: string;
  /** The id of the message reacted to. */
  target: string;
  /** Empty string means the reaction was removed. */
  emoji: string;
}

/** A link row in the shape `/resources` serves. */
export interface StubResource {
  t: number;
  s: string;
  n: string | null;
  url: string;
}

/** One recorded outbound send, so an eval can assert on delivery. */
export interface StubSend {
  jid?: string;
  text?: string;
  idempotencyKey?: string;
}

export interface StubBridgeOptions {
  /** Shared secret the stub demands on `x-bridge-secret`. */
  secret: string;
  messages?: readonly StubMessage[];
  reactions?: readonly StubReaction[];
  resources?: readonly StubResource[];
}

export interface StubBridge {
  /** Base URL to put in `BRIDGE_URL`. */
  url: string;
  /** Everything POSTed to `/send`, in order. */
  sends: StubSend[];
  close: () => Promise<void>;
}

/**
 * Start the stub and wait until it is actually listening. Port 0 so several can
 * run at once — eve evals default to a concurrency of 8.
 */
export const startStubBridge = async (options: StubBridgeOptions): Promise<StubBridge> => {
  const sends: StubSend[] = [];
  const body = {
    messages: options.messages ?? [],
    reactions: options.reactions ?? [],
    resources: options.resources ?? [],
  };

  const server: Server = createServer((req, res) => {
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };

    // The real bridge rejects an unauthenticated call, and `bridge-client`
    // treats 4xx as non-retryable. Checking it here keeps a missing
    // WHATSAPP_BRIDGE_SECRET in an eval a loud failure rather than silent
    // fixture data.
    if (req.headers["x-bridge-secret"] !== options.secret) {
      json(401, { error: "unauthorized" });
      return;
    }

    const path = new URL(req.url ?? "/", "http://stub").pathname;
    // `/messages` → `{ messages: [...] }`, and the same for reactions and
    // resources: each endpoint keys its array by its own name.
    const collection = path.slice(1);

    if (req.method === "GET" && collection in body) {
      json(200, { [collection]: body[collection as keyof typeof body] });
      return;
    }

    if (req.method === "POST" && path === "/send") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        try {
          sends.push(JSON.parse(raw) as StubSend);
        } catch {
          json(400, { error: "invalid JSON body" });
          return;
        }
        json(200, { sent: true });
      });
      return;
    }

    json(404, { error: "not found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    close: async () => {
      server.close();
      await once(server, "close");
    },
    sends,
    url: `http://127.0.0.1:${port}`,
  };
};
