import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** `api/spec.json`: what an agent loads. The repo layout fixes where it is. */
const SPEC_PATH = resolve(import.meta.dirname, "../../../../api/spec.json");

let cached: unknown;

export function loadSpecJson(): unknown {
  cached ??= JSON.parse(readFileSync(SPEC_PATH, "utf-8"));
  return cached;
}
