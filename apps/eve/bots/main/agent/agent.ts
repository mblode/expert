import { defineAgent } from "eve";

// String model id → Vercel AI Gateway (`AI_GATEWAY_API_KEY` on the guest).
// Sonnet with adaptive thinking is the configuration Vibey's eval suite was
// tuned on (`vcmc-agent`, 2026), and since 2026-09-06 that agent is the one
// every computer runs. Swap in an @ai-sdk provider here for a direct key.
export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  modelOptions: {
    providerOptions: {
      anthropic: { thinking: { type: "adaptive" } },
    },
  },
});
