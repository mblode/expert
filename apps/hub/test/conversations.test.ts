import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerError } from "@computer/shared";
import type { Route } from "@computer/shared";
import {
  ConversationRegistry,
  FileConversationStore,
  FileMessageLog,
  MemoryConversationStore,
  MemoryMessageLog,
} from "../src/service/conversations.ts";

const chat = (jid: string): Route => ({ acct: "main", jid, kind: "whatsapp" });
const HUMAN = { kind: "human", ref: "1@s.whatsapp.net" } as const;
const BOT = { bot: "main", kind: "bot" } as const;

const registry = (): ConversationRegistry =>
  new ConversationRegistry(new MemoryConversationStore(), new MemoryMessageLog());

describe("conversations", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { force: true, recursive: true });
    }
  });

  it("creates one conversation per route and reuses it on the next inbound", () => {
    const conv = registry();
    const first = conv.resolve("main", chat("g@g.us"), [BOT, HUMAN]);
    const again = conv.resolve("main", chat("g@g.us"), [BOT, HUMAN]);
    expect(again.id).toBe(first.id);
    expect(conv.list()).toHaveLength(1);

    // A different chat on the same number, and the same chat on a different
    // number, are each their own record: the route is the identity.
    const other = conv.resolve("main", chat("other@g.us"), [BOT, HUMAN]);
    const second = conv.resolve("main", { acct: "work", jid: "g@g.us", kind: "whatsapp" }, [BOT]);
    expect(new Set([first.id, other.id, second.id]).size).toBe(3);
    // And so is the same route under another Bot's voice.
    expect(conv.resolve("night", chat("g@g.us"), [BOT]).id).not.toBe(first.id);
  });

  it("does not rewrite an existing record's participants from a later inbound", () => {
    const conv = registry();
    const created = conv.resolve("main", chat("g@g.us"), [BOT, HUMAN]);
    const seenAgain = conv.resolve("main", chat("g@g.us"), [
      BOT,
      { kind: "human", ref: "2@s.whatsapp.net" },
    ]);
    // A group has many members and one message names one of them. The record
    // is the hub's, not the transport's.
    expect(seenAgain.participants).toEqual(created.participants);
  });

  it("appends in order, and last_seq matches the tail of the log", () => {
    const store = new MemoryConversationStore();
    const log = new MemoryMessageLog();
    const conv = new ConversationRegistry(store, log);
    const record = conv.resolve("main", chat("g@g.us"), [BOT, HUMAN]);
    conv.append(record.id, HUMAN, { kind: "human", text: "hello" });
    conv.append(record.id, BOT, { images: [], kind: "text", text: "on it" });
    conv.append(record.id, BOT, { images: [], kind: "text", text: "done" });

    const lines = log.load(record.id);
    expect(lines.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(lines.map((m) => m.body.kind)).toEqual(["human", "text", "text"]);
    expect(store.load()[0]!.last_seq).toBe(3);
    expect(store.load()[0]!.last_seq).toBe(lines.at(-1)!.seq);
    expect(store.load()[0]!.updated_at >= record.created_at).toBe(true);
  });

  it("pages flat entries oldest first, carrying conversation_id and author", () => {
    const conv = registry();
    const record = conv.resolve("main", chat("g@g.us"), [BOT, HUMAN]);
    conv.append(record.id, HUMAN, { kind: "human", text: "hello" });
    const said = conv.append(record.id, BOT, { images: [], kind: "text", text: "hi" }, "turn_x");

    const page = conv.page(record.id);
    expect(page.next_cursor).toBeNull();
    expect(page.entries.map((e) => e.kind)).toEqual(["human", "text"]);
    // Flat, like every other `Seat.Occurrences` entry, plus the two new fields.
    expect(page.entries[1]).toMatchObject({
      author: { bot: "main", kind: "bot" },
      conversation_id: record.id,
      id: said.id,
      kind: "text",
      seq: 2,
      text: "hi",
      turn_id: "turn_x",
    });

    // The cursor contract is the one `VoiceService.page` already had.
    const first = conv.page(record.id, undefined, 1);
    expect(first.next_cursor).toBe("1");
    expect(conv.page(record.id, first.next_cursor!).entries.map((e) => e.seq)).toEqual([2]);
  });

  it("keeps the turn rules per conversation, not per Bot", () => {
    const conv = registry();
    const a = conv.resolve("main", chat("a@g.us"), [BOT, HUMAN]);
    const b = conv.resolve("main", chat("b@g.us"), [BOT, HUMAN]);

    const widget = conv.send(a.id, BOT, {
      answer: null,
      kind: "widget",
      options: ["yes", "no"],
      prompt: "Which?",
    });
    expect(widget.turn_ended).toBe(true);
    expect(widget.conversation_id).toBe(a.id);
    expect(() => conv.send(a.id, BOT, { images: [], kind: "text", text: "more" })).toThrow(
      /turn ended/,
    );
    // The other chat is untouched: one Bot, two conversations, two turns.
    expect(conv.send(b.id, BOT, { images: [], kind: "text", text: "hi" }).turn_ended).toBe(false);
    // And a person speaking re-opens the turn that ended.
    conv.append(a.id, HUMAN, { kind: "human", text: "yes" });
    expect(conv.send(a.id, BOT, { images: [], kind: "text", text: "ok" }).turn_ended).toBe(false);
  });

  it("refuses an unknown conversation rather than inventing one", () => {
    const conv = registry();
    expect(() => conv.byId("conv_nope")).toThrow(ComputerError);
    expect(() => conv.page("conv_nope")).toThrow(/no conversation/);
  });

  it("persists 0600 in a 0700 dir, one JSONL file per conversation", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-conversations-"));
    dirs.push(dir);
    const data = join(dir, "data");
    const conv = new ConversationRegistry(
      new FileConversationStore(join(data, "conversations.json")),
      new FileMessageLog(join(data, "conversations")),
    );
    const record = conv.resolve("main", chat("g@g.us"), [BOT, HUMAN]);
    conv.append(record.id, BOT, { images: [], kind: "text", text: "hi" });

    const perms = (p: string) => statSync(p).mode.toString(8).slice(-3);
    expect(perms(join(data, "conversations.json"))).toBe("600");
    expect(perms(join(data, "conversations"))).toBe("700");
    expect(perms(join(data, "conversations", `${record.id}.jsonl`))).toBe("600");

    // A fresh hub over the same files sees the same conversation and keeps
    // numbering where the last one stopped, so a held cursor still means
    // what it meant.
    const restarted = new ConversationRegistry(
      new FileConversationStore(join(data, "conversations.json")),
      new FileMessageLog(join(data, "conversations")),
    );
    expect(restarted.resolve("main", chat("g@g.us"), [BOT]).id).toBe(record.id);
    expect(restarted.append(record.id, BOT, { images: [], kind: "text", text: "again" }).seq).toBe(
      2,
    );
  });

  it("tolerates a torn last line and numbers past the tail the index missed", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-conversations-"));
    dirs.push(dir);
    const data = join(dir, "data");
    const indexPath = join(data, "conversations.json");
    const conv = new ConversationRegistry(
      new FileConversationStore(indexPath),
      new FileMessageLog(join(data, "conversations")),
    );
    const record = conv.resolve("main", chat("g@g.us"), [BOT, HUMAN]);
    conv.append(record.id, BOT, { images: [], kind: "text", text: "one" });
    conv.append(record.id, BOT, { images: [], kind: "text", text: "two" });

    const logPath = join(data, "conversations", `${record.id}.jsonl`);
    // A crash mid-append: half a line at the end of the file.
    writeFileSync(logPath, `${readFileSync(logPath, "utf-8")}{"id":"occ_tor`);
    // And a crash between the line and the index bump: the index is behind.
    const stale = JSON.parse(readFileSync(indexPath, "utf-8")) as { last_seq: number }[];
    stale[0]!.last_seq = 1;
    writeFileSync(indexPath, JSON.stringify(stale));

    const restarted = new ConversationRegistry(
      new FileConversationStore(indexPath),
      new FileMessageLog(join(data, "conversations")),
    );
    // The torn line is skipped, not fatal, and the two good ones survive.
    expect(restarted.page(record.id).entries.map((e) => e.seq)).toEqual([1, 2]);
    // The next seq comes off the log's tail, never off the index alone, so
    // two entries can never both claim 2.
    expect(restarted.append(record.id, BOT, { images: [], kind: "text", text: "three" }).seq).toBe(
      3,
    );
  });

  it("refuses an index file it cannot make sense of rather than reading it as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-conversations-"));
    dirs.push(dir);
    const path = join(dir, "conversations.json");
    writeFileSync(
      path,
      JSON.stringify([{ bot: "main", id: "conv_x", route: { kind: "carrier" } }]),
    );
    // An unknown route kind is a file this hub does not understand. Mounting
    // it as "no conversations" would have the next write erase the record.
    expect(() => new FileConversationStore(path).load()).toThrow(/unknown route kind/);
    writeFileSync(path, "{}");
    expect(() => new FileConversationStore(path).load()).toThrow(/must be a JSON array/);
  });
});
