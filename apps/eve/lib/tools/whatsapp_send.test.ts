import { describe, expect, it } from "vitest";
import { postEnvelope, resolveBridge } from "../bridge.ts";
import type { BridgeDeps } from "../bridge.ts";
import {
  buildEnvelope,
  chatFromAttributes,
  NO_CHAT_NOTE,
  NO_QUOTE,
  whatsappSend,
} from "./whatsapp_send.ts";

const ENV = { COMPUTER_BRIDGE_URL: "http://127.0.0.1:2100", WHATSAPP_BRIDGE_SECRET: "s3cret" };
const CHAT = { acct: "main", jid: "g@g.us", messageId: "m0123456789" };

/** A fetch that records the one request it gets and answers with `status`/`body`. */
const stubFetch = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fn = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      init: init ?? {},
      url: String(url),
    });
    return Promise.resolve(Response.json(body, { status }));
  };
  return { calls, deps: { env: ENV, fetch: fn } as BridgeDeps };
};

describe("chatFromAttributes", () => {
  it("reads the chat, the message id and the account off the session", () => {
    expect(
      chatFromAttributes({
        acct: "main",
        groupJid: "g@g.us",
        messageId: "m0123456789",
        via: "hub",
      }),
    ).toEqual({ acct: "main", jid: "g@g.us", messageId: "m0123456789" });
  });

  it("is null on a surface with no chat, and ignores non-string attributes", () => {
    expect(chatFromAttributes(undefined)).toBeNull();
    expect(chatFromAttributes({})).toBeNull();
    expect(chatFromAttributes({ groupJid: "  " })).toBeNull();
    expect(chatFromAttributes({ groupJid: ["g@g.us"] })).toBeNull();
  });

  it("keeps a chat with no message id (an older bridge sends none)", () => {
    expect(chatFromAttributes({ groupJid: "g@g.us" })).toEqual({ jid: "g@g.us" });
  });
});

describe("buildEnvelope", () => {
  it("quotes the message being answered by default", () => {
    expect(buildEnvelope({ text: "on it" }, CHAT)).toEqual({
      envelope: { acct: "main", jid: "g@g.us", reply_to: "m0123456789", text: "on it" },
    });
  });

  it("quotes another message when one is named", () => {
    const built = buildEnvelope({ reply_to: "mabcdef0123", text: "about that" }, CHAT);
    expect(built).toHaveProperty("envelope.reply_to", "mabcdef0123");
  });

  it("sends unquoted only when asked for it, and never invents a quote without a message id", () => {
    expect(buildEnvelope({ reply_to: NO_QUOTE, text: "hi" }, CHAT)).toEqual({
      envelope: { acct: "main", jid: "g@g.us", text: "hi" },
    });
    expect(buildEnvelope({ text: "hi" }, { jid: "g@g.us" })).toEqual({
      envelope: { jid: "g@g.us", text: "hi" },
    });
  });

  it("anchors a reaction on the same message as a reply", () => {
    expect(buildEnvelope({ react: "👍" }, CHAT)).toEqual({
      envelope: {
        acct: "main",
        jid: "g@g.us",
        react: { emoji: "👍", to: "m0123456789" },
        reply_to: "m0123456789",
      },
    });
  });

  it("refuses locally what the bridge could only refuse remotely", () => {
    expect(buildEnvelope({}, CHAT)).toEqual({
      error: "nothing to send: pass text, react or media",
    });
    expect(buildEnvelope({ react: "👍", reply_to: NO_QUOTE }, CHAT)).toEqual({
      error: "a reaction needs a message to sit on: pass reply_to with a message_id from this chat",
    });
  });

  it("cleans text and captions the way a reply is cleaned", () => {
    const built = buildEnvelope(
      {
        media: [{ base64: "AA==", caption: "## Look", kind: "image", mime: "image/png" }],
        text: "**bold** and a — dash",
      },
      CHAT,
    );
    expect(built).toHaveProperty("envelope.text", "*bold* and a, dash");
    expect(built).toHaveProperty("envelope.media.0.caption", "*Look*");
  });

  it("drops a caption that cleans away to nothing", () => {
    const built = buildEnvelope(
      { media: [{ base64: "AA==", caption: "   ", kind: "image", mime: "image/png" }] },
      CHAT,
    );
    // toStrictEqual so a surviving `caption: undefined` fails here.
    expect(built).toStrictEqual({
      envelope: {
        acct: "main",
        jid: "g@g.us",
        media: [{ base64: "AA==", kind: "image", mime: "image/png" }],
        reply_to: "m0123456789",
      },
    });
  });
});

describe("resolveBridge", () => {
  it("needs a secret, not just a URL", () => {
    expect(resolveBridge({ COMPUTER_BRIDGE_URL: "http://127.0.0.1:2100" })).toBeNull();
    expect(resolveBridge({ WHATSAPP_BRIDGE_SECRET: "   " })).toBeNull();
  });

  it("falls back to the loopback bridge and trims a trailing slash", () => {
    expect(resolveBridge({ WHATSAPP_BRIDGE_SECRET: "s" })).toEqual({
      base: "http://127.0.0.1:2100",
      secret: "s",
    });
    expect(
      resolveBridge({ BRIDGE_URL: "https://b.example/", WHATSAPP_BRIDGE_SECRET: "s" }),
    ).toEqual({ base: "https://b.example", secret: "s" });
  });
});

describe("postEnvelope", () => {
  it("posts the envelope with the shared secret and returns the ids", async () => {
    const { calls, deps } = stubFetch(200, { message_ids: ["3EB0"], sent: true });
    await expect(postEnvelope({ jid: "g@g.us", text: "hi" }, deps)).resolves.toEqual({
      messageIds: ["3EB0"],
      ok: true,
    });
    const [call] = calls;
    expect(call?.url).toBe("http://127.0.0.1:2100/send-envelope");
    expect((call?.init.headers as Record<string, string>)?.["x-bridge-secret"]).toBe("s3cret");
    expect(call?.body).toEqual({ jid: "g@g.us", text: "hi" });
  });

  it("separates a policy refusal from a malformed request", async () => {
    const refused = stubFetch(403, { error: "daily send limit reached for this chat" });
    await expect(postEnvelope({ jid: "g@g.us", text: "hi" }, refused.deps)).resolves.toEqual({
      kind: "refused",
      ok: false,
      reason: "daily send limit reached for this chat",
    });
    const malformed = stubFetch(400, { error: "react.emoji must be a single emoji" });
    await expect(postEnvelope({ jid: "g@g.us", text: "hi" }, malformed.deps)).resolves.toEqual({
      kind: "malformed",
      ok: false,
      reason: "react.emoji must be a single emoji",
    });
  });

  it("treats a bad credential or an older bridge as unreachable, not as advice", async () => {
    for (const status of [401, 404, 502]) {
      const { deps } = stubFetch(status, { error: "nope" });
      await expect(postEnvelope({ jid: "g@g.us", text: "hi" }, deps)).resolves.toMatchObject({
        kind: "unreachable",
        ok: false,
      });
    }
  });

  it("returns rather than throws when there is no bridge to call", async () => {
    const deps: BridgeDeps = {
      env: {},
      fetch: () => {
        throw new Error("must not be called");
      },
    };
    await expect(postEnvelope({ jid: "g@g.us", text: "hi" }, deps)).resolves.toEqual({
      kind: "unreachable",
      ok: false,
      reason: "this Bot holds no WhatsApp bridge credential",
    });
  });

  it("returns rather than throws when the socket is dead", async () => {
    const deps: BridgeDeps = { env: ENV, fetch: () => Promise.reject(new Error("ECONNREFUSED")) };
    await expect(postEnvelope({ jid: "g@g.us", text: "hi" }, deps)).resolves.toEqual({
      kind: "unreachable",
      ok: false,
      reason: "the WhatsApp bridge is not reachable",
    });
  });
});

describe("whatsappSend", () => {
  it("sends the default quoted reply and reports the ids", async () => {
    const { calls, deps } = stubFetch(200, { message_ids: ["3EB0"], sent: true });
    await expect(whatsappSend({ text: "on it" }, CHAT, deps)).resolves.toEqual({
      message_ids: ["3EB0"],
      sent: true,
    });
    expect(calls[0]?.body).toEqual({
      acct: "main",
      jid: "g@g.us",
      reply_to: "m0123456789",
      text: "on it",
    });
  });

  it("hands back a refusal the model can read and must not retry", async () => {
    const { deps } = stubFetch(403, { error: "text into a group must quote a message in it" });
    await expect(whatsappSend({ text: "hi", reply_to: NO_QUOTE }, CHAT, deps)).resolves.toEqual({
      problem: "refused",
      reason: "text into a group must quote a message in it",
      retry: false,
      sent: false,
    });
  });

  it("marks a malformed field as worth one corrected retry", async () => {
    const { deps } = stubFetch(400, { error: "react.emoji must be a single emoji" });
    await expect(whatsappSend({ react: "not an emoji" }, CHAT, deps)).resolves.toEqual({
      problem: "malformed",
      reason: "react.emoji must be a single emoji",
      retry: true,
      sent: false,
    });
  });

  it("answers a local mistake without spending a round trip", async () => {
    const { calls, deps } = stubFetch(200, { sent: true });
    await expect(whatsappSend({}, CHAT, deps)).resolves.toEqual({
      problem: "malformed",
      reason: "nothing to send: pass text, react or media",
      retry: true,
      sent: false,
    });
    expect(calls).toHaveLength(0);
  });

  it("degrades to available:false off a WhatsApp turn", async () => {
    await expect(whatsappSend({ text: "hi" }, null, { env: ENV })).resolves.toEqual({
      available: false,
      note: NO_CHAT_NOTE,
    });
  });

  it("degrades to available:false with no bridge behind it", async () => {
    await expect(whatsappSend({ text: "hi" }, CHAT, { env: {} })).resolves.toEqual({
      available: false,
      note: "this Bot holds no WhatsApp bridge credential, so answer in text instead",
    });
  });
});
