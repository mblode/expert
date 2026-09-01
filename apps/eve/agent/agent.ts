import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";

// Direct provider, not the AI Gateway. The gateway is a second network
// dependency in front of every turn, and when it stalled the agent could
// not see its own screen — the box was fine and the model call never
// landed. OPENAI_API_KEY selects this path; swap in another @ai-sdk
// provider, or a gateway model id string, without touching anything else.
export default defineAgent({
  model: openai("gpt-5"),
});
