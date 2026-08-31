import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";
import { hubRpc } from "../lib/hub";

type ShellResponse = {
  exit: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
};

export default defineTool({
  description:
    "Run a command on my computer: argv in /workspace (or cwd under it). Not a login shell; timeout 1–120s. Prefer this over the screen for anything a terminal does well.",
  inputSchema: z.object({
    request_id: z.string().min(1).describe("Idempotency key — same id retries safely"),
    argv: z.array(z.string()).min(1).max(32),
    cwd: z.string().optional(),
    timeout_sec: z.number().int().min(1).max(120).optional(),
  }),
  // First shell command per session asks the human once; after that it flows.
  approval: once(),
  async execute(input) {
    return await hubRpc<ShellResponse>("shell", input);
  },
});
