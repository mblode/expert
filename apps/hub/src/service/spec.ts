import { DISPLAY, SPEC_ID, SPEC_VERSION, TOOLS, WORKSPACE } from "@computer/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function specResponse() {
  return {
    id: SPEC_ID,
    version: SPEC_VERSION,
    display: DISPLAY,
    workspace: WORKSPACE,
    tools: [...TOOLS],
  };
}

export function loadSpecJson(): unknown {
  const candidates = [
    resolve(process.cwd(), "../../api/spec.json"),
    resolve(process.cwd(), "api/spec.json"),
    resolve(import.meta.dirname, "../../../../api/spec.json"),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      // try next
    }
  }
  return specResponse();
}
