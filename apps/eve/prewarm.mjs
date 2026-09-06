// Provision the sandbox templates a built Bot will ask for, the step `eve
// start` runs before it spawns `.output/server/index.mjs` and that the hub
// skips by spawning the built server itself (`eveChildCommand` in
// apps/hub/src/host/eve.ts). Without it the first turn that touches the
// sandbox, which on a computer with tenant skill files is the first turn,
// dies with SandboxTemplateNotProvisionedError: `eve build` only prewarms on
// Vercel, and a bundled server never provisions on demand. eve exports no
// public prewarm, so this reaches the same function `eve start` calls by
// file path. Run from a Bot directory after `eve build`; the template lands
// in `.eve/sandbox-cache` beside `.output` and its key is a pure function of
// the build, so the image can carry it.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(`${process.cwd()}/`);
const prewarm = require
  .resolve("eve/package.json")
  .replace(/package\.json$/, "dist/src/execution/sandbox/prewarm.js");
const { prewarmBuiltAppSandboxes } = await import(pathToFileURL(prewarm).href);
await prewarmBuiltAppSandboxes({ appRoot: process.cwd(), log: (line) => console.log(line) });
