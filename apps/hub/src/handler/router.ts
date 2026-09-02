import type { IncomingMessage, ServerResponse } from "node:http";
import { ComputerError, unavailable } from "@computer/shared";
import type { ErrorCode } from "@computer/shared";
import { ALL_METHODS } from "@computer/proto";
import type { AuthPolicy } from "@computer/proto";
import type { AuthRegistry } from "./auth.ts";
import { bearerFromHeader } from "./auth.ts";
import type { PrincipalRecord } from "../service/principals.ts";

type Handler = (ctx: RpcContext) => Promise<unknown>;

export interface RpcContext {
  body: unknown;
  bearer?: string;
  kind: "agent" | "seat" | "public";
  /** Set for agent calls: the Bot the bearer token belongs to. */
  botId?: string;
  /** Set for anything authenticated. Handlers bind a display-bound principal to its screen. */
  principal?: PrincipalRecord;
}

interface Route {
  policy: AuthPolicy;
  handler: Handler;
}

/**
 * Connect-JSON unary router.
 * A method without an auth policy fails registration.
 */
export class ConnectRouter {
  private readonly routes = new Map<string, Route>();
  private readonly extras = new Map<
    string,
    { method: string; policy: AuthPolicy; handler: Handler }
  >();

  constructor(private readonly auth: AuthRegistry) {}

  rpc(path: string, policy: AuthPolicy, handler: Handler): void {
    if (!policy) {
      throw new Error(`Connect method ${path} registered without an auth policy`);
    }
    if (!ALL_METHODS.includes(path as (typeof ALL_METHODS)[number]) && !path.startsWith("/")) {
      throw new Error(`invalid path ${path}`);
    }
    this.routes.set(path, { handler, policy });
  }

  /** Extra HTTP JSON endpoints (GET /spec, /healthz, /roster). Still require a policy. */
  extra(method: string, path: string, policy: AuthPolicy, handler: Handler): void {
    if (!policy) {
      throw new Error(`Connect method ${path} registered without an auth policy`);
    }
    this.extras.set(`${method} ${path}`, { handler, method, policy });
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
      await this.dispatch(req, res, extra.policy, extra.handler, url.pathname);
      return true;
    }
    if (req.method !== "POST") {
      return false;
    }
    const route = this.routes.get(url.pathname);
    if (!route) {
      return false;
    }
    await this.dispatch(req, res, route.policy, route.handler, url.pathname);
    return true;
  }

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    policy: AuthPolicy,
    handler: Handler,
    method: string,
  ): Promise<void> {
    try {
      const bearer = bearerFromHeader(header(req, "authorization"));
      const verified = this.auth.verify(policy, bearer, method);
      const body = req.method === "GET" || req.method === "HEAD" ? {} : await readJson(req);
      const result = await handler({
        bearer,
        body,
        botId: verified.botId,
        kind: verified.kind,
        principal: verified.principal,
      });
      writeJson(res, 200, result ?? {});
    } catch (error) {
      writeError(res, error);
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
    error: {
      code: "DAEMON_DOWN" satisfies ErrorCode,
      message,
      ...unavailable("unknown", "unknown"),
    },
  });
}

/**
 * Same CORS on OPTIONS and on JSON so the Vercel-hosted web app can call the
 * hub cross-origin. `*` is safe only because every call is bearer-authenticated
 * and nothing here reads cookies.
 */
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-headers":
      "authorization, content-type, connect-protocol-version, x-computer-bot",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": "*",
  };
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(data),
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(),
  });
  res.end(data);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Largest JSON body: a 20-action batch or a 4000-char type is kilobytes; a screenshot never goes this way. */
const MAX_BODY_BYTES = 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new ComputerError("VALIDATION", "body too large");
    }
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) {
    return {};
  }
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
