import { defineAgent } from "eve";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
export default defineAgent({
  modelContextWindowTokens: 100_000,
  model: {
    specificationVersion: "v3",
    provider: "test",
    modelId: "deterministic",
    supportedUrls: {},
    async doGenerate({ prompt }) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(prompt.filter((entry) => entry.role !== "assistant")),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
    async doStream({ prompt }) {
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            c.enqueue({ type: "text-start", id: "1" });
            c.enqueue({
              type: "text-delta",
              id: "1",
              delta: JSON.stringify(prompt.filter((entry) => entry.role !== "assistant")),
            });
            c.enqueue({ type: "text-end", id: "1" });
            c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            c.close();
          },
        }),
      };
    },
  },
});
