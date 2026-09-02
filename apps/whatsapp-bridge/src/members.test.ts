// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadMembersOverlay, parseMembers } from "./members.ts";

test("parseMembers keeps rows with a phone and a name, defaulting tags", () => {
  const members = parseMembers([
    { name: " Ada ", phone: " +61400000000 ", role: "founder" },
    { name: "No phone" },
    { phone: "+61411111111" },
    "not an object",
    null,
  ]);
  assert.deepEqual(members, [{ name: "Ada", phone: "+61400000000", role: "founder", tags: [] }]);
});

test("parseMembers ignores a non-array payload", () => {
  assert.deepEqual(parseMembers({ name: "Ada", phone: "1" }), []);
  assert.deepEqual(parseMembers(null), []);
});

test("loadMembersOverlay reads a JSON file and treats a missing one as empty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wa-members-"));
  const file = path.join(dir, "members.json");
  await writeFile(file, JSON.stringify([{ name: "Ada", phone: "+61400000000", tags: ["core"] }]));
  assert.deepEqual(await loadMembersOverlay(file), [
    { name: "Ada", phone: "+61400000000", tags: ["core"] },
  ]);
  assert.deepEqual(await loadMembersOverlay(null), []);
  const errors: unknown[] = [];
  assert.deepEqual(
    await loadMembersOverlay(path.join(dir, "missing.json"), (e) => errors.push(e)),
    [],
  );
  assert.equal(errors.length, 1);
});
