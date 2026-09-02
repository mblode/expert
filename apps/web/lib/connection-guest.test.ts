import { describe, expect, it, vi } from "vitest";

import { writeConnectionFile } from "./connection-guest";
import { VIBEY_HUB_URL } from "./computers";

const secret = "sk-live-not-for-html";
const source = [
  'import { defineMcpClientConnection } from "eve/connections";',
  "",
  "export default defineMcpClientConnection({",
  "  auth: { getToken: async () => ({ token: process.env.COMPUTER_CONNECTION_DONE_BEAR! }) },",
  '  url: "https://mcp.donebear.app/",',
  "});",
  "",
].join("\n");

describe("writeConnectionFile", () => {
  it("pairs nothing itself: CreateBot, WriteFile with the bot token, then DeleteBot", async () => {
    const calls: { auth: string; body: unknown; url: string }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization") ?? "";
      const body: unknown = JSON.parse(String(init?.body));
      calls.push({ auth, body, url });
      if (url === `${VIBEY_HUB_URL}/computer.v1.Seat/CreateBot`) {
        expect(auth).toBe("Bearer seat_vibey");
        expect(body).toEqual({ id: expect.stringMatching(/^xw[a-f0-9]{8}$/u) });
        return Response.json({
          display: 2,
          id: (body as { id: string }).id,
          token: "bot_write",
        });
      }
      if (url === `${VIBEY_HUB_URL}/computer.v1.Agent/WriteFile`) {
        expect(auth).toBe("Bearer bot_write");
        expect(body).toEqual({
          content: source,
          path: "/workspace/eve/bots/agent/connections/done-bear.ts",
        });
        expect(JSON.stringify(body)).not.toContain(secret);
        expect(JSON.stringify(body)).not.toContain("ProvideSecret");
        return Response.json({ bytes: source.length });
      }
      if (url === `${VIBEY_HUB_URL}/computer.v1.Seat/DeleteBot`) {
        expect(auth).toBe("Bearer seat_vibey");
        expect(body).toEqual({ id: expect.stringMatching(/^xw[a-f0-9]{8}$/u) });
        return Response.json({ state: "AGENT" });
      }
      throw new Error(`unexpected ${url}`);
    });

    const ok = await writeConnectionFile({
      fetchImpl,
      hubUrl: VIBEY_HUB_URL,
      path: "/workspace/eve/bots/agent/connections/done-bear.ts",
      seatToken: "seat_vibey",
      source,
    });
    expect(ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      `${VIBEY_HUB_URL}/computer.v1.Seat/CreateBot`,
      `${VIBEY_HUB_URL}/computer.v1.Agent/WriteFile`,
      `${VIBEY_HUB_URL}/computer.v1.Seat/DeleteBot`,
    ]);
    expect(calls[0]?.url).not.toContain("mblode-computer");
    expect(JSON.stringify(calls)).not.toContain(secret);
  });

  it("deletes the throwaway bot when WriteFile fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const body: unknown = JSON.parse(String(init?.body));
      if (url.endsWith("/CreateBot")) {
        return Response.json({ id: (body as { id: string }).id, token: "bot_write" });
      }
      if (url.endsWith("/WriteFile")) {
        return Response.json({ error: { code: "SEAT_HELD", message: "human" } }, { status: 409 });
      }
      if (url.endsWith("/DeleteBot")) {
        return Response.json({ state: "HUMAN" });
      }
      throw new Error(url);
    });
    expect(
      await writeConnectionFile({
        fetchImpl,
        hubUrl: VIBEY_HUB_URL,
        path: "/workspace/eve/bots/agent/connections/done-bear.ts",
        seatToken: "seat_vibey",
        source,
      }),
    ).toBe(false);
    expect(fetchImpl.mock.calls.map(([input]) => String(input).split("/").pop())).toEqual([
      "CreateBot",
      "WriteFile",
      "DeleteBot",
    ]);
  });
});
