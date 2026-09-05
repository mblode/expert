import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Registrations } from "./registrations.ts";

test("clock leases persist and cannot name an unconfigured tenant or use another tenant's secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "expert-clock-"));
  try {
    const path = join(dir, "registrations.json");
    const secrets = { one: "a".repeat(32), two: "b".repeat(32) };
    const registry = new Registrations(path, secrets);
    const body = { tenant: "one", id: "c".repeat(64), until: 2000 };
    assert.throws(() => registry.put(body, secrets.two, ["one", "two"], 1000));
    assert.throws(() =>
      registry.put({ ...body, tenant: "https://untrusted" }, secrets.one, ["one"], 1000),
    );
    registry.put(body, secrets.one, ["one"], 1000);
    assert.equal(new Registrations(path, secrets).active("one", 1000), true);
    assert.equal(registry.active("one", 2000), false);
    registry.put({ ...body, until: 0 }, secrets.one, ["one"], 1000);
    assert.equal(new Registrations(path, secrets).active("one", 1000), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scheduled check survives downtime and stays due until explicitly advanced or cancelled", () => {
  const dir = mkdtempSync(join(tmpdir(), "expert-clock-check-"));
  try {
    const path = join(dir, "registrations.json");
    const secret = "a".repeat(32);
    const registry = new Registrations(path, { one: secret });
    const body = { tenant: "one", id: "d".repeat(64), until: 0, at: 60_000 };
    registry.put(body, secret, ["one"], 0);
    assert.equal(registry.active("one", 59_999), false);
    const restarted = new Registrations(path, { one: secret });
    assert.equal(restarted.active("one", 24 * 60 * 60_000), true);
    restarted.put({ ...body, at: 120_000 }, secret, ["one"], 60_000);
    assert.equal(restarted.active("one", 60_000), false);
    restarted.put({ tenant: "one", id: body.id, until: 0 }, secret, ["one"], 70_000);
    assert.equal(new Registrations(path, { one: secret }).active("one", 200_000), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
