import { defineTool } from "eve/tools";
import { z } from "zod";
import { hubRpc } from "../hub.ts";

export default defineTool({
  description:
    "Write a UTF-8 file on my computer. Paths live under /workspace; relative paths resolve there.",
  inputSchema: z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
  async execute(input) {
    return await hubRpc<{ bytes: number }>("writeFile", input);
  },
});
