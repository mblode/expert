import { eq, sql } from "drizzle-orm";

import { computer } from "../db/computer";
import { computerSeat } from "../db/computer-seat";
import type { ComputerChoice, ComputerRecord } from "./computers";
import {
  accessibleComputers,
  choicesOf,
  computersFromEnv,
  boundComputerId,
  pairComputer,
  revokeSeat,
} from "./computers";
import { db } from "./db";
import { ownedComputer } from "./computer-enrollment";

/** Every seat call here resolves to one, so a route can name what it holds. @public */
export interface ComputerSeat {
  computerId: string;
  computers: ComputerChoice[];
  hubUrl: string;
  seatToken?: string;
  seatError?: string;
  /**
   * The account may not open the computer it asked for, as opposed to the hub
   * being unreachable. Only `bindComputerSeat` can say that, and only it sets
   * this; the route reads it to answer 403 rather than 502. It used to answer
   * by matching the first two words of `seatError`, so rewording the sentence
   * silently turned a refusal into a gateway error.
   */
  denied?: boolean;
}

export async function accountComputers(userId: string, email: string): Promise<ComputerRecord[]> {
  const seeded = accessibleComputers(email, process.env);
  const owned = await ownedComputer(userId);
  return owned ? [owned.record, ...seeded] : seeded;
}

async function viewFor(
  userId: string,
  email: string,
  target: ComputerRecord,
  extra: Partial<ComputerSeat> = {},
): Promise<ComputerSeat> {
  return {
    computerId: target.id,
    computers: choicesOf(await accountComputers(userId, email)),
    hubUrl: target.hubUrl,
    ...extra,
  };
}

export async function ensureComputerCatalog(): Promise<void> {
  await db.run(sql`CREATE TABLE IF NOT EXISTS computer (
    id TEXT PRIMARY KEY NOT NULL, hub_url TEXT NOT NULL, label TEXT NOT NULL,
    setup_code_env TEXT NOT NULL, issuer_token TEXT, issuer_updated_at INTEGER
  )`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS computer_seat (
    user_id TEXT PRIMARY KEY NOT NULL, computer_id TEXT NOT NULL,
    hub_url TEXT NOT NULL, seat_token TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  for (const row of computersFromEnv(process.env)) {
    await db
      .insert(computer)
      .values({
        hubUrl: row.hubUrl,
        id: row.id,
        label: row.label,
        setupCodeEnv: row.setupCodeEnv,
      })
      .onConflictDoUpdate({
        set: { hubUrl: row.hubUrl, label: row.label, setupCodeEnv: row.setupCodeEnv },
        target: computer.id,
      });
  }
}

/**
 * Pair, then remember the token for this user on this computer.
 *
 * This is the last per-request `Pair` in the control plane, and it stays one
 * deliberately. A signed-in user on hello.expert is an `owner`: the workspace
 * reads `/roster`, streams pixels and talks to the Bot through `/eve/v1`, and
 * all three are owner-only HTTP routes rather than RPCs, so no `methods` list
 * and no narrower role reaches them. An `issuer` may not issue `owner`, which
 * is the containment that makes the stored issuer worth having, so moving
 * this path onto `Seat.Issue` is not a swap: it needs those three doors to
 * stop being owner-only first, which is a hub change and its own decision
 * about what a hello.expert session is allowed to be. See docs/AUDIT.md.
 */
async function pairAndPersist(
  userId: string,
  email: string,
  target: ComputerRecord,
): Promise<ComputerSeat> {
  const owned = await ownedComputer(userId);
  const env =
    owned?.record.id === target.id
      ? { ...process.env, [target.setupCodeEnv]: owned.setupCode }
      : process.env;
  const paired = await pairComputer(target, env);
  if ("error" in paired) {
    return viewFor(userId, email, target, { seatError: paired.error });
  }
  try {
    await ensureComputerCatalog();
    await db.insert(computer).values(target).onConflictDoNothing();
    await db
      .insert(computerSeat)
      .values({
        computerId: target.id,
        hubUrl: target.hubUrl,
        seatToken: paired.token,
        updatedAt: new Date(),
        userId,
      })
      .onConflictDoUpdate({
        set: {
          computerId: target.id,
          hubUrl: target.hubUrl,
          seatToken: paired.token,
          updatedAt: new Date(),
        },
        target: computerSeat.userId,
      });
  } catch {
    // An unrecorded owner would be minted again on every session read.
    // Refuse and revoke rather than handing out an untracked credential.
    await revokeSeat(target, paired.token);
    return viewFor(userId, email, target, {
      seatError: "Could not save your connection. Try again.",
    });
  }
  return viewFor(userId, email, target, { seatToken: paired.token });
}

async function pickBound(
  userId: string,
  email: string,
  storedId: string | undefined,
): Promise<ComputerRecord | undefined> {
  const allowed = await accountComputers(userId, email);
  if (storedId) {
    const kept = allowed.find((row) => row.id === storedId);
    if (kept) {
      return kept;
    }
  }
  const fallbackId = boundComputerId(email, process.env);
  return allowed.find((row) => row.id === fallbackId) ?? allowed[0];
}

async function noneConfigured(userId: string, email: string): Promise<ComputerSeat> {
  return {
    computerId: "",
    computers: choicesOf(await accountComputers(userId, email)),
    hubUrl: "",
    seatError: "No computer is configured for this account.",
  };
}

export async function getOrCreateComputerSeat(
  userId: string,
  email: string,
): Promise<ComputerSeat> {
  try {
    const [row] = await db
      .select()
      .from(computerSeat)
      .where(eq(computerSeat.userId, userId))
      .limit(1);
    if (row?.seatToken) {
      const bound = await pickBound(userId, email, row.computerId);
      if (bound && bound.id === row.computerId) {
        return viewFor(userId, email, bound, {
          hubUrl: bound.hubUrl,
          seatToken: row.seatToken,
        });
      }
      if (bound) {
        return pairAndPersist(userId, email, bound);
      }
    }
  } catch {
    // Table may not exist yet on a fresh Turso: Pair still works.
  }
  const bound = await pickBound(userId, email, undefined);
  return bound ? pairAndPersist(userId, email, bound) : noneConfigured(userId, email);
}

/** The hub forgot this token (a wiped seats.json): pair the bound computer again. */
export async function refreshComputerSeat(userId: string, email: string): Promise<ComputerSeat> {
  let storedId: string | undefined;
  try {
    const [row] = await db
      .select()
      .from(computerSeat)
      .where(eq(computerSeat.userId, userId))
      .limit(1);
    storedId = row?.computerId;
  } catch {
    // Pair the default binding.
  }
  const bound = await pickBound(userId, email, storedId);
  return bound ? pairAndPersist(userId, email, bound) : noneConfigured(userId, email);
}

/** Bind this session to a computer the account may open, then Pair that hub. */
export async function bindComputerSeat(
  userId: string,
  email: string,
  computerId: string,
): Promise<ComputerSeat> {
  const allowed = await accountComputers(userId, email);
  const target = allowed.find((row) => row.id === computerId);
  if (!target) {
    const fallback = await pickBound(userId, email, undefined);
    if (!fallback) {
      return noneConfigured(userId, email);
    }
    return viewFor(userId, email, fallback, {
      denied: true,
      seatError: "That computer is not available for this account.",
    });
  }
  return pairAndPersist(userId, email, target);
}
