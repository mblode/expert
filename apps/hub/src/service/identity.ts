import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { jwtVerify } from "jose";
import { ComputerError } from "@computer/shared";

/**
 * A verified human identity. `userId` is `auth.users.id` — one computer
 * per email, so this is also the seat key.
 */
export type Identity = { userId: string; email?: string };

export type IdentityVerifier = (jwt: string) => Promise<Identity>;

/**
 * Persist `userId → seat token` so every client of the same account
 * attaches to the same desktop, including across a hub restart.
 */
export interface IdentityStore {
  load(): Record<string, string>;
  save(map: Record<string, string>): void;
}

export class MemoryIdentityStore implements IdentityStore {
  private map: Record<string, string> = {};

  load(): Record<string, string> {
    return { ...this.map };
  }

  save(map: Record<string, string>): void {
    this.map = { ...map };
  }
}

export class FileIdentityStore implements IdentityStore {
  constructor(private readonly path: string) {}

  load(): Record<string, string> {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(
        `identities ${this.path} could not be read (${(err as Error).message}). It is the only record of who owns which seat — fix the file or move it aside to start fresh.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `identities ${this.path} is not valid JSON (${(err as Error).message}). Restore it from a backup, or move it aside to start fresh.`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`identities ${this.path} must be a JSON object of userId → seat token`);
    }
    const out: Record<string, string> = {};
    for (const [userId, token] of Object.entries(parsed)) {
      if (typeof token !== "string" || !token) {
        throw new Error(`identities ${this.path} values must be strings`);
      }
      out[userId] = token;
    }
    return out;
  }

  save(map: Record<string, string>): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${basename(this.path)}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

/**
 * Build a verifier from env. JWT secret is local HS256 (no network).
 * Service role is the Auth `getUser` fallback for projects that do not
 * expose a shared HMAC secret. Returns undefined when neither is set —
 * `Seat.Session` then refuses, and Pair remains the local-dev door.
 */
export function createIdentityVerifier(opts: {
  jwtSecret?: string;
  supabaseUrl?: string;
  serviceRoleKey?: string;
}): IdentityVerifier | undefined {
  const secret = opts.jwtSecret?.trim();
  const url = opts.supabaseUrl?.trim().replace(/\/+$/, "");
  const service = opts.serviceRoleKey?.trim();
  if (secret) return (jwt) => verifyHs256(jwt, secret);
  if (url && service) return (jwt) => verifyViaAuthUser(jwt, url, service);
  return undefined;
}

export async function verifyHs256(jwt: string, secret: string): Promise<Identity> {
  let payload: Record<string, unknown>;
  try {
    const { payload: p } = await jwtVerify(jwt, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
    });
    payload = p as Record<string, unknown>;
  } catch {
    throw new ComputerError("UNAUTHENTICATED", "bad token");
  }
  return identityFromClaims(payload);
}

async function verifyViaAuthUser(jwt: string, supabaseUrl: string, serviceRoleKey: string): Promise<Identity> {
  let res: Response;
  try {
    res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        apikey: serviceRoleKey,
      },
    });
  } catch {
    throw new ComputerError("UNAUTHENTICATED", "cannot reach auth");
  }
  if (!res.ok) throw new ComputerError("UNAUTHENTICATED", "bad token");
  const body: unknown = await res.json().catch(() => null);
  if (!body || typeof body !== "object") throw new ComputerError("UNAUTHENTICATED", "bad token");
  const rec = body as Record<string, unknown>;
  const user = rec.user && typeof rec.user === "object" ? (rec.user as Record<string, unknown>) : rec;
  return identityFromClaims(user);
}

function identityFromClaims(claims: Record<string, unknown>): Identity {
  const userId = typeof claims.sub === "string" ? claims.sub : typeof claims.id === "string" ? claims.id : "";
  if (!userId) throw new ComputerError("UNAUTHENTICATED", "token has no sub");
  const role = claims.role;
  if (typeof role === "string" && role !== "authenticated" && role !== "anon") {
    throw new ComputerError("UNAUTHENTICATED", "bad token");
  }
  const email = typeof claims.email === "string" ? claims.email : undefined;
  return { userId, email };
}
