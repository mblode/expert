#!/usr/bin/env node
/**
 * proto:check: api/computer.proto is the source of truth.
 * 1. buf lint
 * 2. buf generate
 * 3. committed gen/ matches generate output
 * 4. spec.json display is 1280x800
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");

const spec = JSON.parse(readFileSync(resolve(root, "api/spec.json"), "utf-8"));
if (spec.id !== "computer.v1") {
  console.error("proto:check: spec.json id must be computer.v1");
  process.exit(1);
}
if (spec.display?.width !== 1280 || spec.display?.height !== 800 || spec.display?.scale !== 1) {
  console.error("proto:check: display must be 1280x800 scale 1");
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

run("npx buf lint");
run("npx buf generate");

// Against HEAD, so staged-but-uncommitted drift is caught too.
const unstaged = execSync("git diff HEAD -- packages/proto/gen", { cwd: root, encoding: "utf-8" });
const untracked = execSync("git ls-files --others --exclude-standard -- packages/proto/gen", {
  cwd: root,
  encoding: "utf-8",
});
if (unstaged.trim() || untracked.trim()) {
  if (unstaged.trim()) {
    process.stdout.write(unstaged);
  }
  if (untracked.trim()) {
    console.error(`untracked:\n${untracked}`);
  }
  console.error("proto:check: packages/proto/gen is stale, run npm run proto:gen and commit");
  process.exit(1);
}

console.log("proto:check ok");
