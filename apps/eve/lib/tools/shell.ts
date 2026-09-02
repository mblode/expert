import { defineTool } from "eve/tools";
import { z } from "zod";
import { hubRpc } from "../hub.ts";

interface ShellResponse {
  exit: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

/**
 * Commands a scheduled run may execute with nobody watching. A routine that
 * checks the box's health reads; anything that writes waits for a person,
 * which on a scheduled run means the turn ends unanswered rather than acts.
 */
const READ_ONLY = new Set([
  "cat",
  "date",
  "df",
  "dpkg",
  "du",
  "find",
  "free",
  "head",
  "hostname",
  "ls",
  "ps",
  "stat",
  "tail",
  "test",
  "uname",
  "uptime",
  "wc",
  "which",
]);

const isReadOnly = (argv: readonly string[]): boolean => {
  const command = argv[0]?.split("/").pop();
  if (!command || !READ_ONLY.has(command)) return false;
  // `find -exec` and `find -delete` write; keep the allowlist honest.
  if (
    command === "find" &&
    argv.some((a) => a === "-exec" || a === "-delete" || a === "-execdir")
  ) {
    return false;
  }
  return true;
};

export default defineTool({
  approval: ({ session, toolName, approvedTools, toolInput }) => {
    if (approvedTools.has(toolName)) return "not-applicable";
    const auth = session.auth.current;
    const isScheduledRun =
      auth?.authenticator === "app" &&
      auth.principalId === "eve:app" &&
      auth.principalType === "runtime";
    if (isScheduledRun && isReadOnly(toolInput?.argv ?? [])) return "not-applicable";
    return "user-approval";
  },
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
