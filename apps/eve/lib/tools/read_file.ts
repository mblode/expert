import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { hubRpc } from "../hub.ts";

export default defineTool({
  approval: never(),
  description:
    "Read a UTF-8 file from my computer. Paths live under /workspace; relative paths resolve there.",
  async execute(input) {
    return await hubRpc<{ content: string }>("readFile", input);
  },
  inputSchema: z.object({
    path: z.string().min(1),
  }),
});
