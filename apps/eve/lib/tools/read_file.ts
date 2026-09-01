import { defineTool } from "eve/tools";
import { z } from "zod";
import { hubRpc } from "../hub.ts";

export default defineTool({
  description:
    "Read a UTF-8 file from my computer. Paths live under /workspace; relative paths resolve there.",
  inputSchema: z.object({
    path: z.string().min(1),
  }),
  async execute(input) {
    return await hubRpc<{ content: string }>("readFile", input);
  },
});
