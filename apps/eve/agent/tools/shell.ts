import { defineTool } from "eve/tools";
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
  //
  // Schedules run in task mode, which cannot park for a person: there, an
  // approval prompt is not a pause, it is a failed run. Those turns carry the
  // app principal, so they skip the gate and the rest of `once()` is inlined —
  // approved once, then free for the remainder of the session.
  approval: ({ session, toolName, approvedTools }) => {
    const auth = session.auth.current;
    const isScheduledRun =
      auth?.authenticator === "app" &&
      auth.principalId === "eve:app" &&
      auth.principalType === "runtime";
    if (isScheduledRun || approvedTools.has(toolName)) return "not-applicable";
    return "user-approval";
  },
  async execute(input) {
    return await hubRpc<ShellResponse>("shell", input);
  },
});
