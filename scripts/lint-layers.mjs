#!/usr/bin/env node
/**
 * Hub layering: handler → service → desk.
 * A layer may only import from the layers below it, so:
 *   - desk may not import handler (or service)
 *   - service may not import handler
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const srcRoot = join(import.meta.dirname, "../apps/hub/src");

/** Each rule: files under `dir` may not import from `forbidden`. */
const RULES = [
  { dir: "desk", forbidden: "handler" },
  { dir: "service", forbidden: "handler" },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

let failed = false;
for (const { dir, forbidden } of RULES) {
  const from = new RegExp(`from\\s+["'][^"']*${forbidden}`);
  const dynamic = new RegExp(`import\\(["'][^"']*${forbidden}`);
  for (const file of walk(join(srcRoot, dir))) {
    const text = readFileSync(file, "utf8");
    if (from.test(text) || dynamic.test(text)) {
      console.error(
        `lint-layers: ${relative(process.cwd(), file)} imports ${forbidden} — ${dir} may not import ${forbidden} (handler → service → desk)`,
      );
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("lint-layers ok");
