import { AgentMethods } from "@computer/proto";
import { ComputerError, DISPLAY, SPEC_ID, SPEC_VERSION, TOOLS, WORKSPACE } from "@computer/shared";
import { parseActions } from "../service/computer.ts";
import type { Bot, BotRegistry } from "../service/bots.ts";
import type { ConnectRouter, RpcContext } from "./router.ts";
import { requireObject } from "./router.ts";

/** Agent token → Bot → screen. The model never names a display. */
export function registerAgent(router: ConnectRouter, bots: BotRegistry): void {
  const bot = (ctx: RpcContext): Bot => {
    if (!ctx.botId) throw new ComputerError("UNAUTHENTICATED", "agent token required");
    return bots.byId(ctx.botId);
  };

  router.rpc(AgentMethods.Spec, "agent", async () => ({
    id: SPEC_ID,
    version: SPEC_VERSION,
    display: DISPLAY,
    workspace: WORKSPACE,
    tools: [...TOOLS],
  }));

  router.rpc(AgentMethods.Computer, "agent", async (ctx) => {
    const o = requireObject(ctx.body);
    if (typeof o.request_id !== "string") throw new ComputerError("VALIDATION", "request_id is required");
    const actions = parseActions(o.actions);
    return bot(ctx).computer.run(o.request_id, actions);
  });

  router.rpc(AgentMethods.Shell, "agent", async (ctx) => {
    const o = requireObject(ctx.body);
    return bot(ctx).files.shell({
      request_id: String(o.request_id ?? ""),
      argv: Array.isArray(o.argv) ? (o.argv as string[]) : [],
      cwd: typeof o.cwd === "string" ? o.cwd : undefined,
      timeout_sec: typeof o.timeout_sec === "number" ? o.timeout_sec : undefined,
    });
  });

  router.rpc(AgentMethods.ReadFile, "agent", async (ctx) => {
    const o = requireObject(ctx.body);
    return bot(ctx).files.readFile(String(o.path ?? ""));
  });

  router.rpc(AgentMethods.WriteFile, "agent", async (ctx) => {
    const o = requireObject(ctx.body);
    return bot(ctx).files.writeFile(String(o.path ?? ""), String(o.content ?? ""));
  });
}
