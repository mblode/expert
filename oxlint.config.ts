import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";

/**
 * Ultracite's presets, minus the rules this codebase deliberately does not
 * follow. Enforcement ladder rung 3: each exemption below is a style the
 * existing code takes everywhere (function declarations, `!` under
 * `noUncheckedIndexedAccess`, async interface methods without `await`,
 * `catch` in tests that loop over requests), so turning the rule on would be
 * a whole-repo rewrite for no behavioural gain. Correctness rules stay on.
 */
export default defineConfig({
  extends: [core, next, react],
  ignorePatterns: [...core.ignorePatterns, "packages/proto/gen/**", "**/.eve/**"],
  rules: {
    // Style the repo takes the other way.
    "func-style": "off",
    "react/function-component-definition": "off",
    "no-use-before-define": "off",
    "sort-keys": "off",
    curly: "off",
    "no-plusplus": "off",
    "no-nested-ternary": "off",
    "unicorn/no-nested-ternary": "off",
    "no-inline-comments": "off",
    "typescript/method-signature-style": "off",
    "typescript/parameter-properties": "off",
    "typescript/consistent-type-definitions": "off",
    "unicorn/import-style": "off",
    "unicorn/consistent-function-scoping": "off",
    "prefer-named-capture-group": "off",
    "require-unicode-regexp": "off",
    // `!` is the escape hatch `noUncheckedIndexedAccess` needs; each use is deliberate.
    "typescript/no-non-null-assertion": "off",
    // `Desk` is an async interface; a fake that returns synchronously still implements it.
    "require-await": "off",
    "class-methods-use-this": "off",
    // Promise wrappers around child processes and timers are the point of those files.
    "promise/avoid-new": "off",
    "promise/prefer-await-to-then": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/param-names": "off",
    "no-promise-executor-return": "off",
    "no-void": "off",
    "unicorn/no-useless-undefined": "off",
    "no-await-in-loop": "off",
    "no-empty-function": "off",
    "max-classes-per-file": "off",
    complexity: "off",
    // Eve tool files are named after the tool (`read_file.ts`); the name is the contract.
    "unicorn/filename-case": "off",
    // Screenshots arrive as base64 data URLs; next/image has nothing to optimise.
    "nextjs/no-img-element": "off",
    // The two noVNC frames need `allow-scripts allow-same-origin` together, and
    // the rule's premise does not hold for them: both are cross-origin to this
    // app, so the origin the frame regains is the hub's and it still cannot
    // reach this document. Without it the frame is opaque-origin and noVNC's
    // own `import()` of rfb.js fails CORS, which renders as a black screen and
    // no error. See the comment on the iframe in `components/desktop-pane.tsx`.
    "react/iframe-missing-sandbox": "off",
    // Switches here are over closed unions; the compiler already refuses a missing arm.
    "default-case": "off",
    // React Compiler cannot lower try/finally yet; the component is skipped, not wrong.
    "react/todo": "off",
    // The desk surface is a keyboard target: role=application is how a screen reader is told so.
    "jsx-a11y/no-noninteractive-tabindex": ["error", { roles: ["application"] }],
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  },
});
