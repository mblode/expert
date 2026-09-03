import { eq, sql } from "drizzle-orm";

import { computer as computerTable } from "../db/computer";
import type { ComputerRecord, EnvMap, HubFailure, IssuedSeat, SeatRequest } from "./computers";
import { issueSeat, pairComputer, revokeSeat, setupCodeFor } from "./computers";
import { db } from "./db";

/**
 * The control plane's own grant on a computer.
 *
 * hello.expert used to hold `COMPUTER_SETUP_CODE` per tenant and `Pair` on
 * every grant: one wrong deploy, one leaked env var, and the Vercel project
 * was a permanent owner of every box it knew. It now pairs exactly once per
 * computer, keeps the `issuer` seat that pairing bought, and issues from that
 * for the rest of the deployment's life. The setup code stays in env for this
 * bootstrap and for disaster recovery, and is read nowhere else.
 *
 * The three rules this file exists to hold:
 *
 * 1. A grant never bootstraps. Missing issuer means the grant is refused, not
 *    that a setup code is spent behind the operator's back. Bootstrapping is
 *    an operator saying so, once, and it is the only path that touches `Pair`.
 * 2. A rejected issuer is forgotten, not retried and never downgraded to
 *    `Pair`. If the hub says the credential is no good, the stored copy is
 *    dead weight and the next grant should say so plainly.
 * 3. Nothing here returns, logs or renders the token. An operator gets
 *    "ready" or an error sentence.
 */
export interface IssuerStore {
  read(computerId: string): Promise<string | undefined>;
  write(computerId: string, token: string, at: Date): Promise<void>;
  clear(computerId: string): Promise<void>;
}

/**
 * Turso, in the `computer` row the issuer belongs to.
 *
 * The alternative was a Vercel env var per computer, which is where the setup
 * code lives, and it fails the thing this change is for: an env var is set by
 * hand, is visible to every function in the project, and cannot be rotated by
 * the deployment that holds it. A row can be written the moment the hub mints
 * it and dropped the moment the hub refuses it, which is what rules 1 and 2
 * above need.
 */
export const dbIssuerStore: IssuerStore = {
  async clear(computerId) {
    await ensureIssuerColumns();
    await db
      .update(computerTable)
      .set({ issuerToken: null, issuerUpdatedAt: null })
      .where(eq(computerTable.id, computerId));
  },
  async read(computerId) {
    await ensureIssuerColumns();
    const [row] = await db
      .select()
      .from(computerTable)
      .where(eq(computerTable.id, computerId))
      .limit(1);
    return row?.issuerToken ?? undefined;
  },
  async write(computerId, token, at) {
    await ensureIssuerColumns();
    await db
      .update(computerTable)
      .set({ issuerToken: token, issuerUpdatedAt: at })
      .where(eq(computerTable.id, computerId));
  },
};

/**
 * The catalog table predates these two columns and SQLite has no
 * ADD COLUMN IF NOT EXISTS, so a duplicate-column error here is the normal
 * path on every deploy after the first. Same shape as `ensureInviteTable`.
 */
async function ensureIssuerColumns(): Promise<void> {
  await db.run(sql`ALTER TABLE computer ADD COLUMN issuer_token TEXT`).catch(() => undefined);
  await db
    .run(sql`ALTER TABLE computer ADD COLUMN issuer_updated_at INTEGER`)
    .catch(() => undefined);
}

export interface IssuerOptions {
  fetchImpl?: typeof fetch;
  store?: IssuerStore;
}

/** The hub said the credential itself is no good, rather than being unreachable. */
function isRejection(failure: HubFailure): boolean {
  return failure.code === "UNAUTHENTICATED" || failure.code === "DENIED";
}

export async function hasIssuer(
  computer: ComputerRecord,
  store: IssuerStore = dbIssuerStore,
): Promise<boolean> {
  try {
    return Boolean(await store.read(computer.id));
  } catch {
    // A database that cannot be read is not a computer without an issuer, but
    // for the operator's status view the answer is the same: not ready.
    return false;
  }
}

/**
 * Spend the setup code once to buy an `issuer`, and store it.
 *
 * The owner minted by `Pair` lives for the length of this function and is
 * revoked in a `finally`, which is the same window the old per-grant path
 * had. The difference is that it is entered once per computer by an operator
 * rather than on every invite redemption, so a crash in it strands one owner
 * that the next bootstrap replaces, instead of one per request forever.
 *
 * The issuer itself is minted with no expiry on purpose: it is this
 * deployment's identity on that computer, not a session, and an expiry would
 * mean invites silently stopping at some hour nobody chose, with the fix
 * being the setup code again. Rotation is a deliberate re-bootstrap, and the
 * kill switch is an owner revoking it at the box, which this control plane
 * then reports rather than working around.
 */
export async function bootstrapIssuer(
  computer: ComputerRecord,
  env: EnvMap,
  opts: IssuerOptions = {},
): Promise<{ ok: true } | HubFailure> {
  const store = opts.store ?? dbIssuerStore;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!setupCodeFor(computer, env)) {
    return {
      error: `The web server is missing ${computer.setupCodeEnv}, so it cannot bootstrap an issuer for the ${computer.label} computer.`,
    };
  }
  const paired = await pairComputer(computer, env, fetchImpl);
  if ("error" in paired) {
    return paired;
  }
  try {
    const issued = await issueSeat(
      computer,
      paired.token,
      {
        label: "hello.expert control plane",
        role: "issuer",
        subject: `control-plane:${computer.id}`,
      },
      fetchImpl,
    );
    if ("error" in issued) {
      return issued;
    }
    try {
      await store.write(computer.id, issued.token, new Date());
    } catch {
      // A grant that cannot be stored is worse than no grant: it would be a
      // live issuer nobody can revoke because nobody knows it. Give the token
      // back to the hub and tell the operator to try again.
      await revokeSeat(computer, issued.token, fetchImpl);
      return { error: "Could not store the issuer credential. Nothing was changed." };
    }
    return { ok: true };
  } finally {
    await revokeSeat(computer, paired.token, fetchImpl);
  }
}

/**
 * Mint a seat as the control plane. This is what every grant path calls.
 *
 * Fail closed, twice over: no stored issuer refuses, and an issuer the hub
 * rejects is dropped and refuses. Neither reaches for `Pair`; a control plane
 * that silently re-owns a box on an auth error is the failure mode this whole
 * change is about.
 */
export async function issueSeatAsIssuer(
  computer: ComputerRecord,
  request: SeatRequest,
  opts: IssuerOptions = {},
): Promise<IssuedSeat | HubFailure> {
  const store = opts.store ?? dbIssuerStore;
  let issuer: string | undefined;
  try {
    issuer = await store.read(computer.id);
  } catch {
    return {
      error: `Could not read this control plane's grant on the ${computer.label} computer.`,
    };
  }
  if (!issuer) {
    return {
      error: `This control plane has no issuer on the ${computer.label} computer yet, so it cannot hand out a seat. An operator has to bootstrap it once.`,
    };
  }
  const issued = await issueSeat(computer, issuer, request, opts.fetchImpl ?? fetch);
  if ("error" in issued && isRejection(issued)) {
    await store.clear(computer.id).catch(() => undefined);
    return {
      ...issued,
      error: `The ${computer.label} computer refused this control plane's issuer, so no seat was granted. An operator has to bootstrap it again.`,
    };
  }
  return issued;
}
