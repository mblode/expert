/**
 * This agent's Bot on the computer hub. COMPUTER_BOT_TOKEN is that Bot's
 * identity and screen; the hub routes. Eve runs beside the hub on loopback.
 */

const paths = {
  computer: "/computer.v1.Agent/Computer",
  readFile: "/computer.v1.Agent/ReadFile",
  sendMessage: "/computer.v1.Agent/SendMessage",
  shell: "/computer.v1.Agent/Shell",
  writeFile: "/computer.v1.Agent/WriteFile",
} as const;

export type HubPath = keyof typeof paths;

/**
 * The hub's turn binding. It arrives on the inbound channel request, rides
 * the session's auth attributes, and goes back here. It is never in the
 * model's context and no tool argument can set it: the hub decides which
 * conversation a `send_message` lands in, not the model.
 */
export const TURN_HEADER = "x-computer-turn";

/** Longer than the hub's own longest call (a 120 s shell, plus the exec round trip). */
const TIMEOUT_MS = 150_000;

export async function hubRpc<T>(path: HubPath, body: unknown, turn?: string): Promise<T> {
  const base = (process.env.COMPUTER_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  const token = process.env.COMPUTER_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "COMPUTER_BOT_TOKEN is not set: this Eve process is a Bot. Mint one with `npm run bot -- new <id>` and start Eve with that token.",
    );
  }
  let res: Response;
  try {
    res = await fetch(`${base}${paths[path]}`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(turn ? { [TURN_HEADER]: turn } : {}),
      },
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const why =
      error instanceof Error && error.name === "TimeoutError"
        ? "did not answer in time"
        : "is not reachable";
    throw new Error(`the computer's hub ${why} at ${base}`, { cause: error });
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: the status line is the whole diagnosis.
  }
  if (!res.ok) {
    const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new Error(
      `${error?.code ?? `HTTP_${res.status}`}: ${error?.message ?? text.slice(0, 200) ?? "hub call failed"}`,
    );
  }
  return json as T;
}
