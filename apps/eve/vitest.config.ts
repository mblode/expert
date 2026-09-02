import { defineConfig } from "vitest/config";

// Pure-function tests only: the channel's helpers, the payload validator and
// format-reply. Nothing here boots eve, so no sandbox or gateway creds needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
