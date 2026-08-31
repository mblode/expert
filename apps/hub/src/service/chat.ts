/**
 * Chat is a hub stream beside Agent/Seat. Not a computer-use verb.
 * BYO API key. Tool loop maps onto the four model tools.
 */
import { ComputerError, SPEC_ID, SPEC_VERSION, TOOLS, WORKSPACE, DISPLAY } from "@computer/shared";
import type { ComputerService } from "./computer.ts";
import type { FileService } from "./files.ts";
import type { SeatService } from "./seat.ts";
import { parseActions } from "./computer.ts";

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; request_id: string }
  | { type: "waiting"; message: string }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

export type ChatDeps = {
  computer: ComputerService;
  files: FileService;
  seat: SeatService;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

const SYSTEM = `You drive a persistent Linux desktop through four tools: computer, shell, read_file, write_file.
Display is 1280×800, origin top-left. Coordinates are pixels of the last full-display screenshot. Zoom does not rematch that space.
On first failing computer action the rest are skipped. If the seat is WAITING or HUMAN, computer returns SEAT_HELD — tell the user to take the seat or tap I'm done.
Do not mention VNC, pairing, or clipboard. Chromium is an app; type into the URL bar instead of navigate.`;

export async function* runChat(deps: ChatDeps, userText: string): AsyncGenerator<ChatEvent> {
  if (!userText.trim()) {
    yield { type: "error", code: "VALIDATION", message: "message is required" };
    return;
  }
  if (!deps.apiKey) {
    yield* runEchoLoop(deps, userText);
    return;
  }
  yield* runLlmLoop(deps, userText);
}

/** Offline / test loop: no vendor key. Still exercises tools when the user asks plainly. */
async function* runEchoLoop(deps: ChatDeps, userText: string): AsyncGenerator<ChatEvent> {
  if (/open computer|takeover|take the seat/i.test(userText)) {
    const id = `chat_${Date.now()}`;
    yield { type: "tool", name: "computer", request_id: id };
    try {
      const r = await deps.computer.run(id, [{ type: "request_takeover" }]);
      if (r.seat === "WAITING") {
        yield { type: "waiting", message: "Seat is waiting. Open Computer and tap I'm done when finished." };
      }
    } catch (err) {
      const e = err instanceof ComputerError ? err : new ComputerError("DAEMON_DOWN", String(err));
      yield { type: "error", code: e.code, message: e.message };
    }
    yield { type: "done" };
    return;
  }
  yield {
    type: "delta",
    text: `Hub is up. Spec ${SPEC_ID} ${SPEC_VERSION}. Tools: ${TOOLS.join(", ")}. Workspace ${WORKSPACE}. Display ${DISPLAY.width}×${DISPLAY.height}. Set OPENAI_API_KEY to enable the agent loop.`,
  };
  yield { type: "done" };
}

async function* runLlmLoop(deps: ChatDeps, userText: string): AsyncGenerator<ChatEvent> {
  const base = (deps.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = deps.model ?? "gpt-4.1";
  const messages: Record<string, unknown>[] = [
    { role: "system", content: SYSTEM },
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
    if (msg.content) yield { type: "delta", text: msg.content };
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      yield { type: "done" };
      return;
    }
    messages.push(msg);
    for (const call of calls) {
      const name = call.function.name;
      const args = parseArgs(call.function.arguments);
      yield { type: "tool", name, request_id: String(args.request_id ?? call.id) };
      const result = await dispatchTool(deps, name, args);
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
