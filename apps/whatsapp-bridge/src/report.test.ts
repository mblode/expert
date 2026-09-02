// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReportMessage, reportDedupKey } from "./report.ts";

test("reportDedupKey normalises case and whitespace within a kind", () => {
  const a = reportDedupKey({
    kind: "feature",
    summary: "Add  issue  TRACKING",
  });
  const b = reportDedupKey({ kind: "feature", summary: "add issue tracking" });
  assert.equal(a, b);
});

test("reportDedupKey distinguishes feature from bug for the same summary", () => {
  assert.notEqual(
    reportDedupKey({ kind: "feature", summary: "search is slow" }),
    reportDedupKey({ kind: "bug", summary: "search is slow" }),
  );
});

test("buildReportMessage labels a feature and includes the requester", () => {
  const text = buildReportMessage(
    {
      kind: "feature",
      requestedBy: "Josh Peak",
      summary: "Add issue tracking",
    },
    "vibey",
  );
  assert.match(text, /^Feature request via @vibey/u);
  assert.match(text, /From: Josh Peak/u);
  assert.match(text, /Add issue tracking/u);
});

test("buildReportMessage labels a bug and appends details when present", () => {
  const text = buildReportMessage(
    {
      details: "Happens on every save in a DM.",
      kind: "bug",
      summary: "admin auth bounce",
    },
    "vibey",
  );
  assert.match(text, /^Bug report via @vibey/u);
  assert.match(text, /Happens on every save in a DM\./u);
});

test("buildReportMessage falls back to 'someone' with no requester", () => {
  const text = buildReportMessage({ kind: "feature", summary: "dark mode" }, "vibey");
  assert.match(text, /From: someone/u);
});
