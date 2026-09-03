import { ComputerError, ROLES } from "@computer/shared";
import type { PrincipalKind, Role } from "@computer/shared";
import { readTokenFile, writeTokenFile } from "./provision.ts";

/**
 * Every bearer the hub accepts, in one shape.
 *
 * Before this there were three unrelated checks: a seat token in `seats.json`,
 * a bot token in `bots.json`, and a connector secret in `connectors.json`, each
 * with its own verify path and its own idea of what a caller may do. None of
 * them recorded *who* was behind a seat, so a second person on one computer
 * was just a second owner token: nothing to attribute, nothing to revoke on
 * its own, and no way to hand someone the mouse without handing them the box.
 *
 * A principal fixes the model, not yet the storage. Bots and connectors still
 * live in their own files (a Bot record carries a display and a desk, which
 * is not auth state) and are adapted into this shape at verify time. Moving
 * them into one store is mechanical once callers speak Principal, and it is
 * deliberately not bundled with an auth rewrite.
 */
export interface PrincipalRecord {
  token: string;
  kind: PrincipalKind;
  role: Role;
  /**
   * Who this represents, as the control plane names them. A user id or an
   * email for a person, a Bot id for a Bot, a service name otherwise. Absent
   * on a token minted by `Pair`, which knows only that someone held the code.
   */
  subject?: string;
  /** ISO time. Absent = never, which is what an owner gets. */
  expires_at?: string;
  /** Bound to one screen. Guests always are; anyone may be. */
  display?: number;
  /** Narrows the role's method set. Never widens it. */
  methods?: string[];
  /** Where the token came from, for the owner's audit view. Never a secret. */
  label?: string;
  created_at: string;
}

export interface PrincipalStore {
  load(): PrincipalRecord[];
  save(records: PrincipalRecord[]): void;
}

export class MemoryPrincipalStore implements PrincipalStore {
  private records: PrincipalRecord[] = [];

  load(): PrincipalRecord[] {
    return this.records;
  }

  save(records: PrincipalRecord[]): void {
    this.records = records;
  }
}

/**
 * Still `seats.json`, on purpose. The file is live on both Fly volumes and
 * holds the only record of who is paired; renaming it buys a tidier name and
 * risks a boot that finds nothing and silently unpairs every device.
 */
export class FilePrincipalStore implements PrincipalStore {
  constructor(private readonly path: string) {}

  load(): PrincipalRecord[] {
    const parsed = readTokenFile(this.path, "principals");
    if (parsed === undefined) {
      return [];
    }
    return parsed.map((entry) => principalFrom(entry, this.path));
  }

  save(records: PrincipalRecord[]): void {
    writeTokenFile(this.path, records);
  }
}

const KINDS: readonly PrincipalKind[] = ["user", "bot", "service"];

/**
 * Two older shapes are still on disk and both keep working.
 *
 * A bare string predates seat scopes entirely: it is an owner that never
 * expires, which is exactly what it meant when it was written. A record with
 * `kind: "owner" | "guest"` is the scoped-seat shape from the phase before
 * this one, where kind carried the role. Neither ever named a subject, so a
 * migrated principal has none, and the hub reports it as an unattributed
 * seat rather than inventing a person.
 */
export function principalFrom(entry: unknown, path: string): PrincipalRecord {
  if (typeof entry === "string") {
    return {
      created_at: "1970-01-01T00:00:00.000Z",
      kind: "user",
      role: "owner",
      token: entry,
    };
  }
  if (!entry || typeof entry !== "object") {
    throw new Error(`principals ${path} must be a JSON array of strings or principal records`);
  }
  const r = entry as Record<string, unknown>;
  if (typeof r.token !== "string" || !r.token) {
    throw new Error(`principals ${path}: a record has no token`);
  }
  const legacyRole = r.kind === "owner" || r.kind === "guest" ? (r.kind as Role) : undefined;
  const role = typeof r.role === "string" ? r.role : legacyRole;
  if (!(typeof role === "string" && (ROLES as readonly string[]).includes(role))) {
    throw new Error(`principals ${path}: ${r.token.slice(0, 6)}… has an unknown role`);
  }
  // A legacy record's `kind` was the role; a person is the only thing that
  // shape was ever used for.
  const kind = legacyRole ? "user" : r.kind;
  if (!(typeof kind === "string" && (KINDS as readonly string[]).includes(kind))) {
    throw new Error(`principals ${path}: ${r.token.slice(0, 6)}… has an unknown kind`);
  }
  return {
    created_at: typeof r.created_at === "string" ? r.created_at : "1970-01-01T00:00:00.000Z",
    kind: kind as PrincipalKind,
    role: role as Role,
    token: r.token,
    ...(typeof r.subject === "string" ? { subject: r.subject } : {}),
    ...(typeof r.expires_at === "string" ? { expires_at: r.expires_at } : {}),
    ...(typeof r.display === "number" ? { display: r.display } : {}),
    ...(Array.isArray(r.methods)
      ? { methods: r.methods.filter((m): m is string => typeof m === "string") }
      : {}),
    ...(typeof r.label === "string" ? { label: r.label } : {}),
  };
}

/** A role a caller asked for on the wire, validated. */
export function asRole(value: unknown): Role {
  if (typeof value === "string" && (ROLES as readonly string[]).includes(value)) {
    return value as Role;
  }
  throw new ComputerError("VALIDATION", `role must be one of ${ROLES.join(", ")}`);
}
