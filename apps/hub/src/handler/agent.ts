import { AgentMethods } from "@computer/proto";
import { ComputerError, DISPLAY, SPEC_ID, SPEC_VERSION, TOOLS, WORKSPACE } from "@computer/shared";
import { ComputerService, parseActions } from "../service/computer.ts";
import { FileService } from "../service/files.ts";
import type { ConnectRouter } from "./router.ts";
import { requireObject } from "./router.ts";

export function registerAgent(
  router: ConnectRouter,
  computer: ComputerService,
  files: FileService,
): void {
  router.rpc(AgentMethods.Spec, "agent", async () => ({
    id: SPEC_ID,
    version: SPEC_VERSION,
    display: DISPLAY,
    workspace: WORKSPACE,
    tools: [...TOOLS],
  }));

  router.rpc(AgentMethods.Computer, "agent", async ({ body }) => {
    const o = requireObject(body);
    if (typeof o.request_id !== "string") throw new ComputerError("VALIDATION", "request_id is required");
    const actions = parseActions(o.actions);
    return computer.run(o.request_id, actions);
  });

  router.rpc(AgentMethods.Shell, "agent", async ({ body }) => {
    const o = requireObject(body);
    return files.shell({
      request_id: String(o.request_id ?? ""),
      argv: Array.isArray(o.argv) ? (o.argv as string[]) : [],
      cwd: typeof o.cwd === "string" ? o.cwd : undefined,
      timeout_sec: typeof o.timeout_sec === "number" ? o.timeout_sec : undefined,
    });
  });

  router.rpc(AgentMethods.ReadFile, "agent", async ({ body }) => {
    const o = requireObject(body);
    return files.readFile(String(o.path ?? ""));
  });

  router.rpc(AgentMethods.WriteFile, "agent", async ({ body }) => {
    const o = requireObject(body);
    return files.writeFile(String(o.path ?? ""), String(o.content ?? ""));
  });
}
