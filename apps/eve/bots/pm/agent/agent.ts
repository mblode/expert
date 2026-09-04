import { defineAgent } from "eve";

// String model id → Vercel AI Gateway (`AI_GATEWAY_API_KEY` on the guest).
// Swap in an @ai-sdk provider in this file if you want a direct key instead.
export default defineAgent({
  model: "openai/gpt-5",
});
