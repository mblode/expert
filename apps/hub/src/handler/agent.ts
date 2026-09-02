import { AgentMethods } from "@computer/proto";
import { ComputerError, DISPLAY, SPEC_ID, SPEC_VERSION, TOOLS, WORKSPACE } from "@computer/shared";
import { parseActions } from "../service/computer.ts";
import { parseSendBody } from "../service/voice.ts";
import type { Bot, BotRegistry } from "../service/bots.ts";
import type { ConnectRouter, RpcContext } from "./router.ts";
import { requireObject } from "./router.ts";

/** Agent token → Bot → screen. The model never names a display. */
export function registerAgent(router: ConnectRouter, bots: BotRegistry): void {
  const bot = (ctx: RpcContext): Bot => {
    if (!ctx.botId) {
      throw new ComputerError("UNAUTHENTICATED", "agent token required");
    }
    return bots.byId(ctx.botId);
  };

  router.rpc(AgentMethods.Spec, "agent", async () => ({
    display: DISPLAY,
    id: SPEC_ID,
    tools: [...TOOLS],
    version: SPEC_VERSION,
    workspace: WORKSPACE,
  }));

  // The voice leads the tool table: everything else is work the human
  // never sees unless this is called.
  router.rpc(AgentMethods.SendMessage, "agent", async (ctx) =>
    bot(ctx).voice.send(parseSendBody(ctx.body)),
  );

  router.rpc(AgentMethods.Computer, "agent", async (ctx) => {
    const o = requireObject(ctx.body);
    if (typeof o.request_id !== "string") {
      throw new ComputerError("VALIDATION", "request_id is required");
    }
    const actions = parseActions(o.actions);
    return bot(ctx).computer.run(o.request_id, actions);
  });

  router.rpc(AgentMethods.Shell, "agent", async (ctx) => {
    const o = requireObject(ctx.body);
    return bot(ctx).files.shell({
      argv: Array.isArray(o.argv) ? (o.argv as string[]) : [],
      cwd: typeof o.cwd === "string" ? o.cwd : undefined,
      request_id: String(o.request_id ?? ""),
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
