import { randomBytes } from "node:crypto";

/**
 * Land an Eve connection file on the guest overlay.
 *
 * Agent.WriteFile is agent-token auth, not seat. Seat has CreateBot,
 * ProvideSecret, and no WriteFile. So the smallest existing path is CreateBot
 * to mint a throwaway agent token, WriteFile onto the shared /workspace, then
 * DeleteBot so the extra screen does not stay.
 *
 * The seat handed in is an `installer`: exactly CreateBot, DeleteBot and
 * Revoke, minutes long, issued by the control plane's own grant rather than
 * paired. This file needs nothing else, which is why the role is shaped this
 * way round. Note the residue: the bot token minted below is a full agent
 * token for as long as the Bot exists, so the DeleteBot in the `finally` is
 * the thing that ends it, not the seat's expiry.
 *
 * ProvideSecret cannot set process.env. It answers an open secret_request
 * by putting a value on the box clipboard. There is no Seat RPC that
 * writes a Fly secret or Eve env var. Static keys stay out of the .ts
 * file; Eve reads process.env.COMPUTER_CONNECTION_* after an operator
 * sets that secret on the guest.
 */

const WRITE_BOT_PREFIX = "xw";

export async function writeConnectionFile(input: {
  hubUrl: string;
  path: string;
  seatToken: string;
  source: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const botId = `${WRITE_BOT_PREFIX}${randomBytes(4).toString("hex")}`;
  const created = await hubJson<{ token?: unknown }>(
    fetchImpl,
    `${input.hubUrl}/computer.v1.Seat/CreateBot`,
    input.seatToken,
    { id: botId },
  );
  if (!created || typeof created.token !== "string" || !created.token) {
    return false;
  }
  try {
    const written = await hubJson<{ bytes?: unknown }>(
      fetchImpl,
      `${input.hubUrl}/computer.v1.Agent/WriteFile`,
      created.token,
      { content: input.source, path: input.path },
    );
    return typeof written?.bytes === "number";
  } finally {
    await hubJson(fetchImpl, `${input.hubUrl}/computer.v1.Seat/DeleteBot`, input.seatToken, {
      id: botId,
    }).catch(() => undefined);
  }
}

async function hubJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  try {
    const res = await fetchImpl(url, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      return null;
    }
    return payload as T;
  } catch {
    return null;
  }
}
