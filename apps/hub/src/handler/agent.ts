import { AgentMethods } from "@computer/proto";
import { ComputerError, DISPLAY, SPEC_ID, SPEC_VERSION, TOOLS, WORKSPACE } from "@computer/shared";
import { parseActions } from "../service/computer.ts";
import { buildBody, parseSendBody } from "../service/voice.ts";
import type { Bot, BotRegistry } from "../service/bots.ts";
import type { ConversationRegistry } from "../service/conversations.ts";
import type { TurnService } from "../service/turns.ts";
import type { ConnectRouter, RpcContext } from "./router.ts";
import { requireObject } from "./router.ts";

interface AgentDeps {
  bots: BotRegistry;
  conversations: ConversationRegistry;
  turns: TurnService;
  /**
   * Keep this Bot awake (`host/wake.ts`). A Bot calling a tool is a Bot at
   * work, and the sleep timer must not run out from under a long turn.
   */
  wake?: (botId: string, display: number) => Promise<void>;
}

/** Agent token → Bot → screen. The model never names a display. */
export function registerAgent(router: ConnectRouter, deps: AgentDeps): void {
  const { bots } = deps;
  const bot = (ctx: RpcContext): Bot => {
    if (!ctx.botId) {
      throw new ComputerError("UNAUTHENTICATED", "agent token required");
    }
    const found = bots.byId(ctx.botId);
    // Fire and forget: the marker is a note about when this Bot may sleep,
    // never something a tool call waits on.
    void deps.wake?.(found.id, found.display).catch(() => {
      /* a Bot that is running does not need waking */
    });
    return found;
  };

  router.rpc(AgentMethods.Spec, "agent", async () => ({
    display: DISPLAY,
    id: SPEC_ID,
    tools: [...TOOLS],
    version: SPEC_VERSION,
    workspace: WORKSPACE,
  }));

  /**
   * Who this Bot is, for the harness to fold into its system prompt.
   *
   * Not a tool, the way `Spec` is not one: the model never sees this call and
   * cannot make it, the harness does before a turn. It is here because the
   * hub is what owns the files this is composed from (the profile, the brief
   * a template wrote, the skill index), and the alternative is every harness
   * assembling an identity of its own out of `read_file` and drifting from
   * the thing that writes it.
   */
  router.rpc(AgentMethods.Identity, "agent", async (ctx) => ({
    prompt: await bot(ctx).state.prompt(),
  }));

  // The voice leads the tool table: everything else is work the human
  // never sees unless this is called.
  router.rpc(AgentMethods.SendMessage, "agent", async (ctx) => {
    const b = bot(ctx);
    const body = parseSendBody(ctx.body);
    // No turn token is the Bot's seat thread, byte for byte as before: the
    // seat surface, the eve TUI and the `/eve/v1` proxy all arrive this way
    // and none of them has a conversation yet. A turn token is the hub's own
    // binding, minted at the connector ingress, so it is trusted over anything
    // in the body, which is the model's.
    if (!ctx.turn) {
      return b.voice.send(body);
    }
    const turn = deps.turns.verify(ctx.turn, b.id);
    return deps.conversations.send(
      turn.conversation_id,
      { bot: b.id, kind: "bot" },
      buildBody(body),
      turn.id,
    );
  });

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
