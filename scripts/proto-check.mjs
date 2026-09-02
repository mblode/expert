#!/usr/bin/env node
/**
 * proto:check — api/computer.proto is the source of truth.
 * 1. packages/proto/computer.proto stays a byte-identical copy
 * 2. buf lint
 * 3. buf generate
 * 4. committed gen/ matches generate output
 * 5. spec.json display is 1280×800
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "api/computer.proto");
const copy = resolve(root, "packages/proto/computer.proto");

if (!existsSync(src) || !existsSync(copy)) {
  console.error("proto:check: missing api/computer.proto or packages/proto/computer.proto");
  process.exit(1);
}

const a = readFileSync(src);
const b = readFileSync(copy);
const ha = createHash("sha256").update(a).digest("hex");
const hb = createHash("sha256").update(b).digest("hex");
if (ha !== hb) {
  console.error("proto:check: packages/proto/computer.proto is not identical to api/computer.proto");
  process.exit(1);
}

const spec = JSON.parse(readFileSync(resolve(root, "api/spec.json"), "utf8"));
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
const unstaged = execSync("git diff HEAD -- packages/proto/gen", { cwd: root, encoding: "utf8" });
const untracked = execSync("git ls-files --others --exclude-standard -- packages/proto/gen", {
  cwd: root,
  encoding: "utf8",
});
if (unstaged.trim() || untracked.trim()) {
  if (unstaged.trim()) process.stdout.write(unstaged);
  if (untracked.trim()) console.error("untracked:\n" + untracked);
  console.error("proto:check: packages/proto/gen is stale — run npm run proto:gen and commit");
  process.exit(1);
}

console.log("proto:check ok");
