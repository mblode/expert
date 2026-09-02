import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { hubRpc } from "../hub.ts";

interface ShellResponse {
  exit: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export default defineTool({
  // The human is already on this box. Hub policy is the gate, not an Approve card.
  approval: never(),
  description:
    "Run a command on my computer: argv in /workspace (or cwd under it). Not a login shell; timeout 1–120s. Prefer this over the screen for anything a terminal does well.",
  async execute(input) {
    return await hubRpc<ShellResponse>("shell", input);
  },
  inputSchema: z.object({
    request_id: z.string().min(1).describe("Idempotency key: same id retries safely"),
    argv: z.array(z.string()).min(1).max(32),
    cwd: z.string().optional(),
    timeout_sec: z.number().int().min(1).max(120).optional(),
  }),
});
