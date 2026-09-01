import type { IncomingMessage, ServerResponse } from "node:http";
import { ComputerError, ERROR_HTTP_STATUS, unavailable, type ErrorCode } from "@computer/shared";
import { ALL_METHODS, type AuthPolicy } from "@computer/proto";
import { AuthRegistry, bearerFromHeader } from "./auth.ts";

type Handler = (ctx: RpcContext) => Promise<unknown>;

export type RpcContext = {
  body: unknown;
  bearer?: string;
  kind: "agent" | "seat" | "public";
  /** Set for agent calls: the Bot the bearer token belongs to. */
  botId?: string;
};

type Route = { policy: AuthPolicy; handler: Handler };

/**
 * Connect-JSON unary router.
 * A method without an auth policy fails registration.
 */
export class ConnectRouter {
  private readonly routes = new Map<string, Route>();
  private readonly extras = new Map<string, { method: string; policy: AuthPolicy; handler: Handler }>();

  constructor(private readonly auth: AuthRegistry) {}

  rpc(path: string, policy: AuthPolicy, handler: Handler): void {
    if (!policy) throw new Error(`Connect method ${path} registered without an auth policy`);
    if (!ALL_METHODS.includes(path as (typeof ALL_METHODS)[number]) && !path.startsWith("/")) {
      throw new Error(`invalid path ${path}`);
    }
    this.routes.set(path, { policy, handler });
  }

  /**
   * Extra HTTP JSON endpoints (chat, GET /spec). Still require a policy.
   */
  extra(method: string, path: string, policy: AuthPolicy, handler: Handler): void {
    if (!policy) throw new Error(`Connect method ${path} registered without an auth policy`);
    this.extras.set(`${method} ${path}`, { method, policy, handler });
  }

  assertAllPolicies(): void {
    for (const path of ALL_METHODS) {
      const r = this.routes.get(path);
      if (!r?.policy) {
        throw new Error(`Connect method ${path} registered without an auth policy`);
      }
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const extra = this.extras.get(`${req.method} ${url.pathname}`);
    if (extra) {
      await this.dispatch(req, res, extra.policy, extra.handler);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/spec") {
      // registered via extra
    }
    if (req.method !== "POST") return false;
    const route = this.routes.get(url.pathname);
    if (!route) return false;
    await this.dispatch(req, res, route.policy, route.handler);
    return true;
  }

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    policy: AuthPolicy,
    handler: Handler,
  ): Promise<void> {
    try {
      const bearer = bearerFromHeader(header(req, "authorization"));
      const verified = this.auth.verify(policy, bearer);
      const body = req.method === "GET" || req.method === "HEAD" ? {} : await readJson(req);
      const result = await handler({ body, bearer, kind: verified.kind, botId: verified.botId });
      writeJson(res, 200, result ?? {});
    } catch (err) {
      writeError(res, err);
    }
  }
}

export function writeError(res: ServerResponse, err: unknown): void {
  if (err instanceof ComputerError) {
    writeJson(res, err.httpStatus(), err.toEnvelope());
    return;
  }
  // A throw that is not a ComputerError is a hub bug, not a diagnosis: say
  // unknown/unknown rather than inventing a reason the client would act on.
  const message = err instanceof Error ? err.message : "internal";
  writeJson(res, 500, {
    error: { code: "DAEMON_DOWN" satisfies ErrorCode, message, ...unavailable("unknown", "unknown") },
  });
}

/** Same CORS on OPTIONS and on JSON so a Vercel-hosted panel can read Pair/Status. */
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, connect-protocol-version",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    ...corsHeaders(),
  });
  res.end(data);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ComputerError("VALIDATION", "invalid JSON");
  }
}

export function requireObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ComputerError("VALIDATION", "body must be an object");
  }
  return body as Record<string, unknown>;
}

void ERROR_HTTP_STATUS;
