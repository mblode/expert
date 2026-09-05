import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformTargets } from "./platform.ts";

const app = "expert-0123456789abcdef0123456789abcdef";
test("platform target discovery persists across outages and rejects arbitrary hosts", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "clock-platform-")), "targets.json");
  let value: unknown = { targets: [{ app, clock_secret: "x".repeat(40) }] };
  const fetcher = (async () => Response.json(value)) as typeof fetch;
  const platform = new PlatformTargets(path, "https://hello.expert", "secret", fetcher);
  await platform.refresh();
  assert.equal(platform.current()[0]?.app, app);
  value = { targets: [{ app: "mblode-computer", clock_secret: "x".repeat(40) }] };
  await platform.refresh();
  assert.equal(platform.current()[0]?.app, app);
  const restarted = new PlatformTargets(path, "https://hello.expert", "secret", (async () => {
    throw new Error("offline");
  }) as typeof fetch);
  await restarted.refresh();
  assert.equal(restarted.current()[0]?.app, app);
});
