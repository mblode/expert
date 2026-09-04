/**
 * The `check` command for Auto Review.
 *
 * The policy service spawns this with the request as JSON on stdin and reads
 * one verdict object on stdout. It exists as a separate process rather than an
 * in-hub call because that is the seam `policy.ts` already defines, and going
 * through it means the reviewer inherits the timeout, the output cap and the
 * fail-closed handling instead of needing its own.
 *
 * Every failure is a non-zero exit with the reason on stderr. What that means
 * is the rule's decision: the shipped catch-all sets `fail_open`, so a gateway
 * outage degrades to the four named rules rather than bricking every shell
 * call on the box.
 */

import { autoReviewConfig, reviewAction } from "../service/auto-review.ts";
import type { PolicyRequest } from "../service/policy.ts";

/** Read all of stdin. The hub writes one small JSON object and closes. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const cfg = autoReviewConfig();
if (!cfg) {
  // Reachable when a hand-written policy names this check on a box with no
  // gateway key. Saying so beats a confusing HTTP error.
  fail("auto-review: AI_GATEWAY_API_KEY is not set");
}

const raw = await readStdin();
let req: PolicyRequest;
try {
  req = JSON.parse(raw) as PolicyRequest;
} catch {
  fail("auto-review: stdin was not JSON");
}

try {
  const verdict = await reviewAction(req, cfg);
  process.stdout.write(JSON.stringify(verdict));
} catch (error) {
  fail(`auto-review: ${(error as Error).message}`);
}
