import { sql } from "drizzle-orm";
import { expect, it } from "vitest";

import { computer } from "../db/computer";
import { computerSeat } from "../db/computer-seat";
import { ensureComputerCatalog } from "./computer-seat";
import { db } from "./db";
import { ensureIssuerColumns } from "./issuer";

it("upgrades a legacy catalog before saving a signed-in user's connection", async () => {
  await expect(ensureIssuerColumns()).rejects.toThrow();
  await db.run(sql`CREATE TABLE computer (
    id TEXT PRIMARY KEY NOT NULL, hub_url TEXT NOT NULL, label TEXT NOT NULL,
    setup_code_env TEXT NOT NULL
  )`);
  await db.run(
    sql`INSERT INTO computer VALUES ('legacy', 'https://legacy.example', 'Legacy', 'LEGACY_CODE')`,
  );

  await ensureComputerCatalog();
  await ensureComputerCatalog();

  const rows = await db.select().from(computer);
  expect(rows.find((row) => row.id === "legacy")).toMatchObject({
    label: "Legacy",
    issuerToken: null,
    issuerUpdatedAt: null,
  });
  expect(rows.some((row) => row.id === "vibey")).toBe(true);
  await db.insert(computerSeat).values({
    userId: "test-user",
    computerId: "vibey",
    hubUrl: "https://test.example",
    seatToken: "test-seat",
    updatedAt: new Date(),
  });
  expect(await db.select().from(computerSeat)).toHaveLength(1);
});
