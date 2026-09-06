import { describe, expect, it } from "vitest";
import { ComputerError } from "@computer/shared";
import { FakeDesk } from "../src/desk/fake.ts";
import { VoiceService, buildBody, parseSendBody } from "../src/service/voice.ts";
import {
  ConversationRegistry,
  MemoryConversationStore,
  MemoryMessageLog,
} from "../src/service/conversations.ts";

/** `ttlMs` shortens the clipboard window; omit it for the shipped two minutes. */
const voice = (ttlMs?: number) => {
  const desk = new FakeDesk();
  const conversations = new ConversationRegistry(
    new MemoryConversationStore(),
    new MemoryMessageLog(),
  );
  return { conversations, desk, v: new VoiceService(desk, "main", conversations, ttlMs) };
};

/** One turn of the timer phase, so a zero-TTL clear has run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("the voice", () => {
  it("a turn that never sends leaves nothing for the human to see", () => {
    const { v } = voice();
    // Work happened; the model thought about it at length. None of that is
    // a bubble, and there is no way to make it one except by sending.
    expect(v.page().entries).toEqual([]);
  });

  it("text does not end the turn, so long work can be several bubbles", () => {
    const { v } = voice();
    const first = v.send({ kind: "text", text: "on it" });
    const second = v.send({ kind: "text", text: "done" });
    expect(first.turn_ended).toBe(false);
    expect(second.turn_ended).toBe(false);
    expect(v.page().entries.map((o) => o.kind)).toEqual(["text", "text"]);
    // The seat thread is a conversation like any other, and says so.
    expect(first.conversation_id).toBe(v.conversationId());
  });

  it("a secret request ends the turn and a second send is rejected", () => {
    const { v } = voice();
    const r = v.send({ kind: "secret_request", label: "2FA code", prompt: "Which?" });
    expect(r.turn_ended).toBe(true);
    expect(() => v.send({ kind: "text", text: "and another thing" })).toThrow(ComputerError);
    expect(() => v.send({ kind: "text", text: "and another thing" })).toThrow(/turn ended/);
  });

  it("a request needs a prompt and a label", () => {
    const { v } = voice();
    expect(() => v.send({ kind: "secret_request", label: "x", prompt: "" })).toThrow(/prompt/);
    expect(() => v.send({ kind: "secret_request", label: "", prompt: "p" })).toThrow(/label/);
  });

  it("a secret goes to the clipboard and nowhere the model can read it", async () => {
    const { desk, v } = voice();
    const { occurrence_id, turn_ended } = v.send({
      kind: "secret_request",
      label: "2FA code",
      prompt: "GitHub is asking for your 2FA code",
    });
    expect(turn_ended).toBe(true);
    expect(v.secretPending()).toBe(true);

    await v.provideSecret(occurrence_id, "424242");

    // The one place it lands.
    expect(desk.clipboard).toBe("424242");
    expect(v.secretPending()).toBe(false);
    // And nowhere else: not the log, not the request record.
    const dump = JSON.stringify(v.page().entries);
    expect(dump).not.toContain("424242");
    const s = v.page().entries.find((o) => o.id === occurrence_id);
    expect(s?.kind === "secret_request" && s.provided).toBe(true);
  });

  it("a delivered secret request cannot be replayed", async () => {
    const { desk, v } = voice();
    const { occurrence_id } = v.send({
      kind: "secret_request",
      label: "2FA code",
      prompt: "GitHub is asking for your 2FA code",
    });
    await v.provideSecret(occurrence_id, "424242");
    // The clipboard is not rewritten and the turn is not re-opened twice.
    await expect(v.provideSecret(occurrence_id, "999999")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(desk.clipboard).toBe("424242");
    expect(v.page().entries.filter((o) => o.kind === "human")).toHaveLength(1);
  });

  it("the secret leaves the clipboard once the paste window closes", async () => {
    const { desk, v } = voice(0);
    const { occurrence_id } = v.send({
      kind: "secret_request",
      label: "2FA code",
      prompt: "GitHub is asking for your 2FA code",
    });
    await v.provideSecret(occurrence_id, "424242");
    // There to be pasted...
    expect(desk.clipboard).toBe("424242");
    await settle();
    // ...and not there to be read by everything else on that display.
    expect(desk.clipboard).toBe("");
    expect(JSON.stringify(v.page().entries)).not.toContain("424242");
  });

  it("does not clear a clipboard someone else has written since", async () => {
    const { desk, v } = voice(0);
    const { occurrence_id } = v.send({
      kind: "secret_request",
      label: "2FA code",
      prompt: "GitHub is asking for your 2FA code",
    });
    await v.provideSecret(occurrence_id, "424242");
    // The agent pasted, then copied something of its own. That copy is not
    // ours to destroy, and the secret is gone from the clipboard either way.
    await desk.clipboardSet("git log --oneline");
    await settle();
    expect(desk.clipboard).toBe("git log --oneline");
  });

  it("pages with a cursor rather than replaying the whole log", () => {
    const { v } = voice();
    for (let i = 0; i < 5; i++) {
      v.send({ kind: "text", text: `m${i}` });
    }
    const first = v.page(undefined, 2);
    expect(first.entries).toHaveLength(2);
    expect(first.next_cursor).toBe("2");
    const second = v.page(first.next_cursor ?? undefined, 2);
    expect(second.entries.map((o) => o.kind === "text" && o.text)).toEqual(["m2", "m3"]);
    const last = v.page("4", 100);
    expect(last.entries).toHaveLength(1);
    expect(last.next_cursor).toBeNull();
  });

  it("a request on the seat thread does not block a send on a WhatsApp conversation", () => {
    const { conversations, v } = voice();
    const chat = conversations.resolve("main", { acct: "main", jid: "g@g.us", kind: "whatsapp" }, [
      { bot: "main", kind: "bot" },
    ]);

    // The human on hello.expert is being waited on.
    v.send({ kind: "secret_request", label: "2FA code", prompt: "Which?" });
    expect(() => v.send({ kind: "text", text: "and another thing" })).toThrow(/turn ended/);

    // A WhatsApp message arrives and gets its answer. Before conversations
    // this failed with CONFLICT, because one Bot had one turnEnded flag and
    // the two surfaces shared it.
    const sent = conversations.send(
      chat.id,
      { bot: "main", kind: "bot" },
      buildBody({ kind: "text", text: "hi" }),
      "turn_x",
    );
    expect(sent.turn_ended).toBe(false);
    expect(sent.conversation_id).toBe(chat.id);
    // The seat thread is still waiting, which is the half that must not change.
    expect(() => v.send({ kind: "text", text: "still?" })).toThrow(/turn ended/);
    // And the two logs are separate files, so nothing crossed over.
    expect(v.page().entries.map((e) => e.kind)).toEqual(["secret_request"]);
    expect(conversations.page(chat.id).entries.map((e) => e.kind)).toEqual(["text"]);
  });

  it("parses the wire body and rejects an unknown kind", () => {
    expect(parseSendBody({ kind: "text", text: "hi" })).toEqual({
      images: undefined,
      kind: "text",
      text: "hi",
    });
    expect(() => parseSendBody({ kind: "shout", text: "hi" })).toThrow(/text or secret_request/);
    expect(() => parseSendBody("hi")).toThrow(/must be an object/);
  });
});
