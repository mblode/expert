import { templateChannel } from "../../../../lib/channels/template.ts";

// The same model this Bot runs (`agent/agent.ts`), so its setup is made
// generic by the model that works from it.
export default templateChannel({ model: "openai/gpt-5" });
