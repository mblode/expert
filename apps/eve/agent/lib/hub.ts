/**
 * The body: this agent's Bot on the computer (expert-computer hub).
 * COMPUTER_BOT_TOKEN identifies the Bot and its screen; the hub does the
 * routing. Runs beside the hub on the box by default (loopback), so nothing
 * here is exposed publicly.
 */

const paths = {
  sendMessage: "/computer.v1.Agent/SendMessage",
  computer: "/computer.v1.Agent/Computer",
  shell: "/computer.v1.Agent/Shell",
  readFile: "/computer.v1.Agent/ReadFile",
  writeFile: "/computer.v1.Agent/WriteFile",
} as const;

export type HubPath = keyof typeof paths;

export async function hubRpc<T>(path: HubPath, body: unknown): Promise<T> {
  const base = (process.env.COMPUTER_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const token = process.env.COMPUTER_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "COMPUTER_BOT_TOKEN is not set — provision one with `npm run bot -- new eve` in the computer repo and put it in apps/eve/.env",
    );
  }
  let res: Response;
  try {
    res = await fetch(`${base}${paths[path]}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`the computer's hub is not reachable at ${base} — start it with \`npm run up\``);
  }
  const json = (await res.json()) as T & { error?: { code?: string; message?: string } };
  if (!res.ok) {
    const code = json.error?.code ?? `HTTP_${res.status}`;
    throw new Error(`${code}: ${json.error?.message ?? "hub call failed"}`);
  }
  return json;
}
