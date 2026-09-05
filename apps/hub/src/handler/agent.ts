import type { RoutineService } from "../service/routines.ts";
import type { AssistantState } from "../service/assistant.ts";
import type { CodingService, CodingSession } from "../service/coding.ts";
import { AgentMethods } from "@computer/proto";
import {
  ComputerError,
  DISPLAY,
  SPEC_ID,
  SPEC_VERSION,
  TOOLS,
  WORKSPACE,
  WORK_DESTINATIONS,
} from "@computer/shared";
import { parseActions } from "../service/computer.ts";
import { buildBody, parseSendBody } from "../service/voice.ts";
import { workLink } from "../service/work-links.ts";
import type { WorkDestination } from "@computer/shared";
import type { Bot, BotRegistry } from "../service/bots.ts";
import type { ConversationRegistry } from "../service/conversations.ts";
import type { TurnService } from "../service/turns.ts";
import type { ConnectRouter, RpcContext } from "./router.ts";
import { requireObject } from "./router.ts";

interface AgentDeps {
  bots: BotRegistry;
  conversations: ConversationRegistry;
  turns: TurnService;
  coding: CodingService;
  assistant: AssistantState;
  routines?: RoutineService;
  paOwner?: { acct: string; jid: string };
  paRepos?: string[];
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

  router.rpc(AgentMethods.Spec, "agent", async (ctx) => ({
    runtime: deps.assistant.read(bot(ctx).id),
    display: DISPLAY,
    id: SPEC_ID,
    tools: [...TOOLS],
    version: SPEC_VERSION,
    workspace: WORKSPACE,
  }));

  // The voice leads the tool table: everything else is work the human
  // never sees unless this is called.
  router.rpc(AgentMethods.SendMessage, "agent", async (ctx) => {
    const b = bot(ctx);
    const input = requireObject(ctx.body);
    const bound = ctx.turn ? deps.turns.verify(ctx.turn, b.id) : undefined;
    if (input.kind === "routine") {
      if (
        !bound?.owner ||
        !deps.paOwner ||
        bound.owner.acct !== deps.paOwner.acct ||
        bound.owner.jid !== deps.paOwner.jid
      )
        throw new ComputerError("DENIED", "routines require the verified personal assistant owner");
      if (!deps.routines)
        throw new ComputerError("DAEMON_DOWN", "routines need the durable wake clock");
      return {
        routines: await deps.routines.configure(b.id, requireObject(input.routine)),
        turn_ended: false,
        conversation_id: bound.conversation_id,
      };
    }
    if (input.kind === "configure") {
      if (
        !bound?.owner ||
        !deps.paOwner ||
        bound.owner.acct !== deps.paOwner.acct ||
        bound.owner.jid !== deps.paOwner.jid
      ) {
        throw new ComputerError(
          "DENIED",
          "configuration changes require the verified personal assistant owner",
        );
      }
      const configuration = requireObject(input.configuration);
      const runtime = deps.assistant.edit(
        b.id,
        configuration,
        `${bound.owner.acct}:${bound.owner.jid}`,
      );
      return { runtime, turn_ended: false, conversation_id: bound.conversation_id };
    }
    let coding: CodingSession | undefined;
    if (input.kind === "code") {
      if (
        !bound?.owner ||
        !deps.paOwner ||
        bound.owner.acct !== deps.paOwner.acct ||
        bound.owner.jid !== deps.paOwner.jid
      ) {
        throw new ComputerError(
          "DENIED",
          "coding dispatch requires the verified personal assistant owner",
        );
      }
      if (typeof input.repo !== "string" || !deps.paRepos?.includes(input.repo)) {
        throw new ComputerError("DENIED", "this repository is not enabled for assistant coding");
      }
      if (typeof input.text !== "string" || !input.text.trim())
        throw new ComputerError("VALIDATION", "a coding brief is required");
      coding = await deps.coding.start({
        bot: b.id,
        repo: input.repo,
        prompt: input.text,
        request_id: bound.id,
        source_conversation_id: bound.conversation_id,
      });
    }
    let link: string | undefined;
    if (input.kind === "link") {
      if (!WORK_DESTINATIONS.includes(input.destination as WorkDestination)) {
        throw new ComputerError("VALIDATION", "destination must be computer, plugins or code");
      }
      link = workLink(input.destination as WorkDestination, b.id, bound?.conversation_id);
    }
    if (coding) link = workLink("code", b.id, coding.conversation_id);
    const body = parseSendBody(
      link
        ? {
            kind: "text",
            text: `${coding ? "Coding started" : `Open ${input.destination}`}:\n${link}`,
          }
        : input,
    );
    // No turn token is the Bot's seat thread, byte for byte as before: the
    // seat surface, the eve TUI and the `/eve/v1` proxy all arrive this way
    // and none of them has a conversation yet. A turn token is the hub's own
    // binding, minted at the connector ingress, so it is trusted over anything
    // in the body, which is the model's.
    if (!ctx.turn) {
      return { ...b.voice.send(body), ...(link ? { url: link } : {}) };
    }
    const turn = bound!;
    const sent = deps.conversations.send(
      turn.conversation_id,
      { bot: b.id, kind: "bot" },
      buildBody(body),
      turn.id,
    );
    return {
      ...sent,
      ...(link ? { url: link } : {}),
      ...(coding ? { coding_session: coding } : {}),
    };
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
