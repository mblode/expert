#!/usr/bin/env node
/**
 * Hub layering: handler → service → desk.
 * A layer may only import from the layers below it, so:
 *   - desk may not import handler or service
 *   - service may not import handler
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const srcRoot = join(import.meta.dirname, "../apps/hub/src");

/** Each rule: files under `dir` may not import from any of `forbidden`. */
const RULES = [
  { dir: "desk", forbidden: ["handler", "service"] },
  { dir: "service", forbidden: ["handler"] },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...walk(p));
    } else if (p.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

let failed = false;
for (const { dir, forbidden } of RULES) {
  for (const layer of forbidden) {
    // A path segment, so `./error-handler.ts` is not a false positive.
    const pattern = new RegExp(`(?:from\\s+|import\\()["'][^"']*/${layer}/`);
    for (const file of walk(join(srcRoot, dir))) {
      if (pattern.test(readFileSync(file, "utf-8"))) {
        console.error(
          `lint-layers: ${relative(process.cwd(), file)} imports ${layer}: ${dir} may not import ${layer} (handler → service → desk)`,
        );
        failed = true;
      }
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log("lint-layers ok");
