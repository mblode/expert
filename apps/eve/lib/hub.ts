/**
 * This agent's Bot on the computer hub. COMPUTER_BOT_TOKEN is that Bot's
 * identity and screen; the hub routes. Eve runs beside the hub on loopback.
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
  const base = (process.env.COMPUTER_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  const token = process.env.COMPUTER_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "COMPUTER_BOT_TOKEN is not set — this Eve process is a Bot. Mint one with `npm run bot -- new <id>` and start Eve with that token.",
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
    throw new Error(`the computer's hub is not reachable at ${base}`);
  }
  const json = (await res.json()) as T & { error?: { code?: string; message?: string } };
  if (!res.ok) {
    const code = json.error?.code ?? `HTTP_${res.status}`;
    throw new Error(`${code}: ${json.error?.message ?? "hub call failed"}`);
  }
  return json;
}
