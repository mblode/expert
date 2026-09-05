import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ensureWorkflowState } from "../src/host/workflow-state.ts";

it("keeps runs on the volume and refuses misplaced state without deleting it", () => {
  const root = mkdtempSync(join(tmpdir(), "expert-workflow-"));
  try {
    const target = join(root, "volume");
    const link = join(root, "image", "workflow");
    ensureWorkflowState(link, target);
    writeFileSync(join(link, "run.json"), '{"parked":true}');
    ensureWorkflowState(link, target);
    expect(readFileSync(join(target, "run.json"), "utf-8")).toBe('{"parked":true}');
    const old = join(root, "old");
    mkdirSync(old);
    writeFileSync(join(old, "important"), "preserve");
    expect(() => ensureWorkflowState(old, target)).toThrow(/preserve and migrate/);
    expect(readFileSync(join(old, "important"), "utf-8")).toBe("preserve");
    const wrong = join(root, "wrong");
    symlinkSync(old, wrong);
    expect(() => ensureWorkflowState(wrong, target)).toThrow(/preserve and migrate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
