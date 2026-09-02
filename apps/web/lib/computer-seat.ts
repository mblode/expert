import { eq } from "drizzle-orm";

import { computer } from "../db/computer";
import { computerSeat } from "../db/computer-seat";
import type { ComputerChoice, ComputerRecord } from "./computers";
import {
  accessibleComputers,
  choicesOf,
  computerById,
  computersFromEnv,
  defaultComputerId,
  pairComputer,
} from "./computers";
import { db } from "./db";

export interface ComputerSeat {
  computerId: string;
  computers: ComputerChoice[];
  hubUrl: string;
  seatToken?: string;
  seatError?: string;
}

function catalog(email: string): ComputerRecord[] {
  return accessibleComputers(email, process.env);
}

function viewFor(
  email: string,
  target: ComputerRecord,
  extra: Partial<ComputerSeat> = {},
): ComputerSeat {
  return {
    computerId: target.id,
    computers: choicesOf(catalog(email)),
    hubUrl: target.hubUrl,
    ...extra,
  };
}

export async function ensureComputerCatalog(): Promise<void> {
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

/** Pair, then remember the token for this user on this computer. */
async function pairAndPersist(
  userId: string,
  email: string,
  target: ComputerRecord,
): Promise<ComputerSeat> {
  const paired = await pairComputer(target, process.env);
  if ("error" in paired) {
    return viewFor(email, target, { seatError: paired.error });
  }
  try {
    await ensureComputerCatalog();
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
    // The next getSession will Pair again; the token is still good now.
  }
  return viewFor(email, target, { seatToken: paired.token });
}

function pickBound(email: string, storedId: string | undefined): ComputerRecord | undefined {
  const allowed = catalog(email);
  if (storedId) {
    const wanted = computerById(storedId, process.env);
    const kept = wanted && allowed.find((row) => row.id === wanted.id);
    if (kept) {
      return kept;
    }
  }
  const fallbackId = defaultComputerId(email, process.env);
  return allowed.find((row) => row.id === fallbackId) ?? allowed[0];
}

function noneConfigured(email: string): ComputerSeat {
  return {
    computerId: "",
    computers: choicesOf(catalog(email)),
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
      const bound = pickBound(email, row.computerId);
      if (bound && bound.id === row.computerId) {
        return viewFor(email, bound, {
          hubUrl: row.hubUrl || bound.hubUrl,
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
  const bound = pickBound(email, undefined);
  return bound ? pairAndPersist(userId, email, bound) : noneConfigured(email);
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
  const bound = pickBound(email, storedId);
  return bound ? pairAndPersist(userId, email, bound) : noneConfigured(email);
}

/** Bind this session to a computer the account may open, then Pair that hub. */
export async function bindComputerSeat(
  userId: string,
  email: string,
  computerId: string,
): Promise<ComputerSeat> {
  const wanted = computerById(computerId, process.env);
  const target = wanted && catalog(email).find((row) => row.id === wanted.id);
  if (!target) {
    const fallback = pickBound(email, undefined);
    if (!fallback) {
      return noneConfigured(email);
    }
    return viewFor(email, fallback, {
      seatError: "That computer is not available for this account.",
    });
  }
  return pairAndPersist(userId, email, target);
}
