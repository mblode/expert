import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { hubRpc } from "../hub.ts";

export default defineTool({
  approval: never(),
  description:
    "Write a UTF-8 file on my computer. Paths live under /workspace; relative paths resolve there.",
  async execute(input) {
    return await hubRpc<{ bytes: number }>("writeFile", input);
  },
  inputSchema: z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
});
