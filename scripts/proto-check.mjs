#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

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

console.log("proto:check ok");
