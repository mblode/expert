import { describe, expect, it } from "vitest";
import { ComputerError } from "@computer/shared";
import { FakeDesk } from "../src/desk/fake.ts";
import { VoiceService, parseSendBody } from "../src/service/voice.ts";

const voice = () => {
  const desk = new FakeDesk();
  return { desk, v: new VoiceService(desk) };
};

describe("the voice", () => {
  it("a turn that never sends leaves nothing for the human to see", () => {
    const { v } = voice();
    // Work happened; the model thought about it at length. None of that is
    // a bubble, and there is no way to make it one except by sending.
    expect(v.page().entries).toEqual([]);
  });

  it("text does not end the turn, so long work can be several bubbles", async () => {
    const { v } = voice();
    expect((await v.send({ kind: "text", text: "on it" })).turn_ended).toBe(false);
    expect((await v.send({ kind: "text", text: "done" })).turn_ended).toBe(false);
    expect(v.page().entries.map((o) => o.kind)).toEqual(["text", "text"]);
  });

  it("a widget ends the turn and a second send is rejected", async () => {
    const { v } = voice();
    const r = await v.send({ kind: "widget", prompt: "Which?", options: ["a", "b"] });
    expect(r.turn_ended).toBe(true);
    await expect(v.send({ kind: "text", text: "and another thing" })).rejects.toThrow(ComputerError);
    await expect(v.send({ kind: "text", text: "and another thing" })).rejects.toThrow(/turn ended/);
  });

  it("answering the widget re-opens the turn and records the choice", async () => {
    const { v } = voice();
    const { occurrence_id } = await v.send({ kind: "widget", prompt: "Which?", options: ["a", "b"] });
    v.answerWidget(occurrence_id, "b");
    const w = v.page().entries.find((o) => o.id === occurrence_id);
    expect(w?.kind === "widget" && w.answer).toBe("b");
    await expect(v.send({ kind: "text", text: "ok, b" })).resolves.toBeTruthy();
  });

  it("rejects a widget answer that was never offered", async () => {
    const { v } = voice();
    const { occurrence_id } = await v.send({ kind: "widget", prompt: "Which?", options: ["a"] });
    expect(() => v.answerWidget(occurrence_id, "z")).toThrow(/one of the offered options/);
  });

  it("enforces 1..6 widget options", async () => {
    const { v } = voice();
    await expect(v.send({ kind: "widget", prompt: "p", options: [] })).rejects.toThrow(/1\.\.6/);
    const seven = ["1", "2", "3", "4", "5", "6", "7"];
    await expect(v.send({ kind: "widget", prompt: "p", options: seven })).rejects.toThrow(/1\.\.6/);
  });

  it("a secret goes to the clipboard and nowhere the model can read it", async () => {
    const { desk, v } = voice();
    const { occurrence_id, turn_ended } = await v.send({
      kind: "secret_request",
      prompt: "GitHub is asking for your 2FA code",
      label: "2FA code",
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

  it("pages with a cursor rather than replaying the whole log", async () => {
    const { v } = voice();
    for (let i = 0; i < 5; i++) await v.send({ kind: "text", text: `m${i}` });
    const first = v.page(undefined, 2);
    expect(first.entries).toHaveLength(2);
    expect(first.next_cursor).toBe("2");
    const second = v.page(first.next_cursor ?? undefined, 2);
    expect(second.entries.map((o) => o.kind === "text" && o.text)).toEqual(["m2", "m3"]);
    const last = v.page("4", 100);
    expect(last.entries).toHaveLength(1);
    expect(last.next_cursor).toBeNull();
  });

  it("parses the wire body and rejects an unknown kind", () => {
    expect(parseSendBody({ kind: "text", text: "hi" })).toEqual({
      kind: "text",
      text: "hi",
      images: undefined,
    });
    expect(() => parseSendBody({ kind: "shout", text: "hi" })).toThrow(/text, widget or secret_request/);
    expect(() => parseSendBody("hi")).toThrow(/must be an object/);
  });
});
