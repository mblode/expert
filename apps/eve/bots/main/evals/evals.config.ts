import { defineEvalConfig } from "eve/evals";

/**
 * Shared eval config. The judge model grades the fuzzy assertions (voice,
 * refusals) and is always separate from the agent under test. A string model id
 * routes through the Vercel AI Gateway, so it needs AI_GATEWAY_API_KEY or
 * VERCEL_OIDC_TOKEN. Run with `npm run test:evals` (eve eval --strict).
 *
 * Three things about this harness that are easy to get wrong, all verified
 * against eve's shipped code rather than the docs (first on 0.30.6, re-checked
 * unchanged on 0.49.0 with its vendored autoevals 0.0.132):
 *
 * 1. Without gateway creds the judge-backed evals **fail**, they do not skip.
 *    `settleEntry` catches the judge's error and promotes the assertion to a
 *    failed gate (severity `gate`, score 0). The only skip path is an explicit
 *    `t.skip()`. So CI without a key is a red suite, not a quiet one.
 *
 * 2. `t.judge.autoevals.closedQA` is **binary**. autoevals' ClosedQA prompt has
 *    `choice_scores: { Y: 1.0, N: 0.0 }`, so the score is only ever 0 or 1 and
 *    every threshold in (0, 1] is the same assertion. `.atLeast(0.6)` and
 *    `.atLeast(0.7)` are identical; the numbers this suite used to carry were
 *    decorative and read as tunable when they weren't. Write `.atLeast(1)` and
 *    get gradation by splitting a criterion into two `closedQA` calls.
 *
 * 3. A soft assertion with **no** threshold can never fail. `computePassed`
 *    resolves the bar as `threshold ?? (severity === "gate" ? 1 : undefined)`
 *    and passes when it's `undefined`. Both `.soft()` with no argument and a
 *    bare `t.judge...closedQA(...)` are tracked-only metrics. `.atLeast(n)`
 *    keeps an assertion soft but thresholded, which `--strict` then enforces;
 *    `.gate()` fails the run regardless of `--strict`.
 */
export default defineEvalConfig({
  judge: { model: "anthropic/claude-opus-4.8" },
});
