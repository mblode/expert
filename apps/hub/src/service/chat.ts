/**
 * Chat is a hub stream beside Agent/Seat. Not a computer-use verb.
 * BYO API key. Tool loop maps onto the five model tools.
 *
 * This is the zero-dependency fallback; Eve is the real harness. Both speak
 * through the same voice, so the human sees one occurrence log either way.
 * Model prose is NOT a bubble here — if the loop never calls send_message,
 * the human correctly sees nothing.
 */
import { ComputerError, SPEC_ID, SPEC_VERSION, TOOLS, WORKSPACE, DISPLAY } from "@computer/shared";
import type { ComputerService } from "./computer.ts";
import type { FileService } from "./files.ts";
import type { SeatService } from "./seat.ts";
import type { BotState } from "./state.ts";
import type { Occurrence, VoiceService } from "./voice.ts";
import { parseSendBody } from "./voice.ts";
import { parseActions } from "./computer.ts";

export type ChatEvent =
  | { type: "occurrence"; occurrence: Occurrence }
  | { type: "tool"; name: string; request_id: string }
  | { type: "waiting"; message: string }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

export type ChatDeps = {
  computer: ComputerService;
  files: FileService;
  seat: SeatService;
  voice: VoiceService;
  /** The Bot's directory on the box. Its profile and memory open the prompt. */
  state?: BotState;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

const SYSTEM = `You drive a persistent Linux desktop through five tools: send_message, computer, shell, read_file, write_file.
send_message is your only voice. Everything else you write is a private scratchpad the user never sees — end a turn without sending and they see nothing at all.
Reply first: your first action on a user turn is a short text send. Acknowledging is not delivering — send again with the result.
A widget or secret_request ends the turn: stop and wait. Never say send_message, hub, seat, port or token to the user; say "my computer".
Display is 1280×800, origin top-left. Coordinates are pixels of the last full-display screenshot. Zoom does not rematch that space.
On first failing computer action the rest are skipped. If the seat is WAITING or HUMAN, computer returns SEAT_HELD — tell the user to take the seat or tap I'm done.
Do not mention VNC, pairing, or clipboard. Chromium is an app; type into the URL bar instead of navigate.`;

/** Where the stream has got to in the voice log. Carried through the turn. */
type Seen = { cursor: number };

/**
 * Yield every occurrence the stream has not sent yet. The voice is the only
 * producer of these, so this is the whole path from agent to human.
 */
function* flush(deps: ChatDeps, seen: Seen): Generator<ChatEvent> {
  for (const occurrence of deps.voice.page(String(seen.cursor), 500).entries) {
    seen.cursor = occurrence.seq;
    yield { type: "occurrence", occurrence };
  }
}

export async function* runChat(deps: ChatDeps, userText: string): AsyncGenerator<ChatEvent> {
  if (!userText.trim()) {
    yield { type: "error", code: "VALIDATION", message: "message is required" };
    return;
  }
  const seen: Seen = { cursor: 0 };
  // A person opened the turn. That records what they said and re-opens the
  // voice if a widget had ended the previous turn.
  deps.voice.sayHuman(userText);
  yield* flush(deps, seen);
  if (!deps.apiKey) {
    yield* runEchoLoop(deps, userText, seen);
    return;
  }
  yield* runLlmLoop(deps, userText, seen);
}

/** Offline / test loop: no vendor key. Still exercises tools when the user asks plainly. */
async function* runEchoLoop(deps: ChatDeps, userText: string, seen: Seen): AsyncGenerator<ChatEvent> {
  if (/open computer|takeover|take the seat/i.test(userText)) {
    const id = `chat_${Date.now()}`;
    yield { type: "tool", name: "computer", request_id: id };
    try {
      const r = await deps.computer.run(id, [{ type: "request_takeover" }]);
      if (r.seat === "WAITING") {
        await deps.voice.send({
          kind: "text",
          text: "The seat is yours — open my computer, and tap I'm done when you're finished.",
        });
        yield* flush(deps, seen);
        yield { type: "waiting", message: "Seat is waiting. Open Computer and tap I'm done when finished." };
      }
    } catch (err) {
      const e = err instanceof ComputerError ? err : new ComputerError("DAEMON_DOWN", String(err));
      yield { type: "error", code: e.code, message: e.message };
    }
    yield { type: "done" };
    return;
  }
  await deps.voice.send({
    kind: "text",
    text: `Hub is up. Spec ${SPEC_ID} ${SPEC_VERSION}. Tools: ${TOOLS.join(", ")}. Workspace ${WORKSPACE}. Display ${DISPLAY.width}×${DISPLAY.height}. Set OPENAI_API_KEY to enable the agent loop.`,
  });
  yield* flush(deps, seen);
  yield { type: "done" };
}

async function* runLlmLoop(
  deps: ChatDeps,
  userText: string,
  seen: Seen,
): AsyncGenerator<ChatEvent> {
  let spoke = false;
  let nudged = false;
  const base = (deps.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = deps.model ?? "gpt-4.1";
  // Who this Bot is and what it was told to remember, read off the box. A desk
  // that will not answer costs the agent its memory, not its turn.
  const preamble = (await deps.state?.prompt()) ?? "";
  const messages: Record<string, unknown>[] = [
    { role: "system", content: preamble ? `${SYSTEM}\n\n${preamble}` : SYSTEM },
    { role: "user", content: userText },
  ];

  for (let step = 0; step < 16; step++) {
    if (deps.seat.getState() !== "AGENT") {
      yield { type: "waiting", message: "Seat is held. Open Computer; tap I'm done to continue." };
      yield { type: "done" };
      return;
    }
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        tools: openaiTools(),
      }),
    });
    if (!res.ok) {
      yield { type: "error", code: "DAEMON_DOWN", message: `llm ${res.status}` };
      return;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string; tool_calls?: ToolCall[] } }[];
    };
    const msg = json.choices?.[0]?.message;
    if (!msg) {
      yield { type: "error", code: "DAEMON_DOWN", message: "empty llm message" };
      return;
    }
    // msg.content is the scratchpad. It is deliberately not emitted: the
    // only way to reach the human is send_message.
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      // Reply-first, enforced once. Silence on a person-opened turn is a
      // bug, so nudge — but only ever once, or a mute model loops forever.
      if (!spoke && !nudged) {
        nudged = true;
        messages.push(msg);
        messages.push({
          role: "system",
          content:
            "You ended a turn a person is waiting on without calling send_message, so they saw nothing. Send them the answer now.",
        });
        continue;
      }
      yield { type: "done" };
      return;
    }
    messages.push(msg);
    for (const call of calls) {
      const name = call.function.name;
      const args = parseArgs(call.function.arguments);
      yield { type: "tool", name, request_id: String(args.request_id ?? call.id) };
      const result = await dispatchTool(deps, name, args);
      for (const ev of flush(deps, seen)) {
        spoke = true;
        yield ev;
      }
      if (deps.seat.getState() === "WAITING") {
        yield { type: "waiting", message: "Seat is waiting. Open Computer and tap I'm done when finished." };
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }
  yield { type: "done" };
}

type ToolCall = { id: string; function: { name: string; arguments: string } };

function parseArgs(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function dispatchTool(
  deps: ChatDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    switch (name) {
      case "send_message":
        return await deps.voice.send(parseSendBody(args));
      case "computer":
        return await deps.computer.run(String(args.request_id ?? ""), parseActions(args.actions));
      case "shell":
        return await deps.files.shell({
          request_id: String(args.request_id ?? ""),
          argv: (args.argv as string[]) ?? [],
          cwd: args.cwd as string | undefined,
          timeout_sec: args.timeout_sec as number | undefined,
        });
      case "read_file":
        return await deps.files.readFile(String(args.path ?? ""));
      case "write_file":
        return await deps.files.writeFile(String(args.path ?? ""), String(args.content ?? ""));
      default:
        return { error: { code: "VALIDATION", message: `unknown tool ${name}` } };
    }
  } catch (err) {
    if (err instanceof ComputerError) return err.toEnvelope();
    return { error: { code: "DAEMON_DOWN", message: String(err) } };
  }
}

function openaiTools() {
  return [
    {
      type: "function",
      function: {
        name: "send_message",
        description:
          "Say something to the human. This is the ONLY thing they see — your other text is a private scratchpad. Reply with a short text send before you start work, and send again with the result. A widget or secret_request ends the turn.",
        parameters: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: { type: "string", enum: ["text", "widget", "secret_request"] },
            text: { type: "string", description: "kind=text. One bubble." },
            prompt: { type: "string", description: "kind=widget or secret_request." },
            options: {
              type: "array",
              items: { type: "string" },
              description: "kind=widget. 1-6 real choices.",
            },
            label: {
              type: "string",
              description:
                "kind=secret_request. What the masked field holds. The value goes to the clipboard, never to you — paste it.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "computer",
        description:
          "Use the desktop. Actions run in order on a 1280×800 display. Coordinates are pixels of the last full-display screenshot.",
        parameters: {
          type: "object",
          required: ["request_id", "actions"],
          properties: {
            request_id: { type: "string" },
            actions: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "shell",
        description: "Run argv in /workspace.",
        parameters: {
          type: "object",
          required: ["request_id", "argv"],
          properties: {
            request_id: { type: "string" },
            argv: { type: "array", items: { type: "string" } },
            cwd: { type: "string" },
            timeout_sec: { type: "integer" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a utf-8 file under /workspace.",
        parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a utf-8 file under /workspace.",
        parameters: {
          type: "object",
          required: ["path", "content"],
          properties: { path: { type: "string" }, content: { type: "string" } },
        },
      },
    },
  ];
}
