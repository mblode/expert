#!/usr/bin/env node
/**
 * Hub layering: desk may not import handler.
 * handler → service → desk
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const deskRoot = join(import.meta.dirname, "../apps/hub/src/desk");

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
for (const file of walk(deskRoot)) {
  const text = readFileSync(file, "utf8");
  if (/from\s+["'][^"']*handler/.test(text) || /import\(["'][^"']*handler/.test(text)) {
    console.error(`lint-layers: ${relative(process.cwd(), file)} imports handler`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("lint-layers ok");
