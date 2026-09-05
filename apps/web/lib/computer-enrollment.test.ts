import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { accountComputers, bindComputerSeat } from "./computer-seat";
import {
  claimComputerEnrollment,
  createComputerEnrollment,
  hasComputerInvitation,
  ownedComputer,
} from "./computer-enrollment";

const draft = () => ({
  email: `${randomUUID()}@example.com`,
  hubUrl: `https://test-${randomUUID()}.fly.dev`,
  label: "Private workspace",
  setupCode: "test-credential-at-least-sixteen",
  createdBy: "operator",
});
const claim = (token: string, email: string, userId = randomUUID()) => ({
  token,
  email,
  userId,
  emailVerified: true,
});

describe("account-owned computer enrollment", () => {
  it("renews an unclaimed invitation without reassigning a claimed computer", async () => {
    const input = draft();
    const first = await createComputerEnrollment(input);
    const renewed = await createComputerEnrollment(input);
    expect(await claimComputerEnrollment(claim(first.token, input.email))).toBe(false);
    expect(await claimComputerEnrollment(claim(renewed.token, input.email))).toBe(true);
    await expect(createComputerEnrollment(input)).rejects.toThrow("already belongs");
  });
  it("claims once with a verified matching email and survives a retry", async () => {
    const input = draft();
    const invitation = await createComputerEnrollment(input);
    const owner = claim(invitation.token, input.email.toUpperCase());
    expect(await hasComputerInvitation(input.email)).toBe(true);
    expect(await claimComputerEnrollment({ ...owner, emailVerified: false })).toBe(false);
    expect(await claimComputerEnrollment({ ...owner, email: "someone-else@example.com" })).toBe(
      false,
    );
    expect(await claimComputerEnrollment(owner)).toBe(true);
    expect(await claimComputerEnrollment(owner)).toBe(true);
    const owned = await ownedComputer(owner.userId);
    expect(owned?.record.hubUrl).toBe(input.hubUrl);
    expect(await claimComputerEnrollment({ ...owner, userId: randomUUID() })).toBe(false);
  });
  it("serialises concurrent claims by different accounts", async () => {
    const input = draft();
    const invitation = await createComputerEnrollment(input);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimComputerEnrollment(claim(invitation.token, input.email)),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("does not allocate a second computer to the same user", async () => {
    const a = draft();
    const b = { ...draft(), email: a.email };
    const first = await createComputerEnrollment(a);
    const second = await createComputerEnrollment(b);
    const userId = randomUUID();
    expect(await claimComputerEnrollment(claim(first.token, a.email, userId))).toBe(true);
    expect(await claimComputerEnrollment(claim(second.token, b.email, userId))).toBe(false);
  });
  it("refuses expired invitations and never writes the raw token", async () => {
    const input = draft();
    const invitation = await createComputerEnrollment(input);
    const rows = await db.all<{ token_hash: string }>(
      sql`SELECT token_hash FROM computer_enrollment WHERE hub_url = ${input.hubUrl}`,
    );
    expect(rows[0]?.token_hash).not.toBe(invitation.token);
    await db.run(
      sql`UPDATE computer_enrollment SET expires_at = 0 WHERE hub_url = ${input.hubUrl}`,
    );
    expect(await hasComputerInvitation(input.email)).toBe(false);
    expect(await claimComputerEnrollment(claim(invitation.token, input.email))).toBe(false);
  });
  it("refuses duplicate machines and seeded tenants", async () => {
    const input = draft();
    await createComputerEnrollment(input);
    await expect(
      createComputerEnrollment({ ...input, email: "another@example.com" }),
    ).rejects.toThrow();
    await expect(
      createComputerEnrollment({ ...input, hubUrl: "https://vcmc-computer.fly.dev" }),
    ).rejects.toThrow("Existing shared");
    await expect(
      createComputerEnrollment({ ...input, hubUrl: "http://127.0.0.1" }),
    ).rejects.toThrow("HTTPS Fly");
  });
  it("resolves only the owner's computer and refuses another tenant's id", async () => {
    const input = draft();
    const invitation = await createComputerEnrollment(input);
    const owner = claim(invitation.token, input.email);
    await claimComputerEnrollment(owner);
    const list = await accountComputers(owner.userId, input.email);
    expect(list.map((item) => item.hubUrl)).toEqual([input.hubUrl]);
    expect(await accountComputers("stranger", "stranger@example.com")).toEqual([]);
    const refused = await bindComputerSeat(owner.userId, input.email, "vibey");
    expect(refused.denied).toBe(true);
    expect(refused.seatToken).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain(input.setupCode);
  });
});
