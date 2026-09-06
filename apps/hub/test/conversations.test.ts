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
import type { Occurrence } from "../src/service/state.ts";

/** Where the pre-conversations log lived, and still lives. */
const TRANSCRIPT = "/workspace/.bots/main/transcript.jsonl";

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

  it("grows an existing record's participants without rewriting them", () => {
    const conv = registry();
    const created = conv.resolve("main", chat("g@g.us"), [BOT, HUMAN]);
    const second = { kind: "human", ref: "2@s.whatsapp.net" } as const;
    const seenAgain = conv.resolve("main", chat("g@g.us"), [BOT, second]);
    // A group has many members and one message names one of them, so the
    // first sender is not the roster. The second speaker joins it; the first
    // is still there, and the Bot is not duplicated.
    expect(seenAgain.id).toBe(created.id);
    expect(seenAgain.participants).toEqual([BOT, HUMAN, second]);
    // Speaking again adds nobody, so a busy group does not rewrite the index
    // once per message.
    expect(conv.resolve("main", chat("g@g.us"), [BOT, second]).participants).toHaveLength(3);
  });

  it("mirrors one line of the tail into the index, for a list of threads", () => {
    const store = new MemoryConversationStore();
    const conv = new ConversationRegistry(store, new MemoryMessageLog());
    const record = conv.resolve("main", chat("g@g.us"), [BOT, HUMAN]);
    const listed = () => conv.list().find((c) => c.id === record.id);

    // Nothing said yet: a row with no preview, not a row with an empty one.
    expect(listed()?.preview).toBeUndefined();

    conv.append(record.id, HUMAN, { kind: "human", text: "  hello\n  there  " });
    // Collapsed to one line, because a row is one line.
    expect(listed()?.preview).toMatchObject({ author: HUMAN, text: "hello there" });

    // The tail, not the first thing said.
    conv.append(record.id, BOT, { images: [], kind: "text", text: "on it" });
    expect(listed()?.preview?.text).toBe("on it");
    expect(listed()?.preview?.author).toEqual(BOT);

    // An image with no caption has nothing to quote and still has to read as
    // a thread with something in it.
    conv.append(record.id, BOT, { images: ["a.png"], kind: "text", text: "" });
    expect(listed()?.preview?.text).toBe("Photo");

    // A question the person has to answer previews as the question.
    conv.append(record.id, BOT, {
      kind: "secret_request",
      label: "OPENAI_API_KEY",
      prompt: "What is the key?",
      provided: false,
    });
    expect(listed()?.preview?.text).toBe("What is the key?");

    // Clipped: the index is rewritten whole on every append.
    conv.append(record.id, HUMAN, { kind: "human", text: "x".repeat(500) });
    expect(listed()?.preview?.text).toHaveLength(140);
  });

  it("keeps the preview across a reload, and drops one that will not render", () => {
    const dir = mkdtempSync(join(tmpdir(), "conv-"));
    dirs.push(dir);
    const path = join(dir, "conversations.json");
    const log = new FileMessageLog(dir);
    const first = new ConversationRegistry(new FileConversationStore(path), log);
    const record = first.resolve("main", chat("g@g.us"), [BOT, HUMAN]);
    first.append(record.id, HUMAN, { kind: "human", text: "hello" });

    const reopened = new ConversationRegistry(new FileConversationStore(path), log);
    expect(reopened.list()[0]?.preview?.text).toBe("hello");

    // Half a preview is a row that throws where none is a row that renders.
    const rows = JSON.parse(readFileSync(path, "utf-8")) as { preview: unknown }[];
    rows[0]!.preview = { text: "hello" };
    writeFileSync(path, JSON.stringify(rows));
    expect(new ConversationRegistry(new FileConversationStore(path), log).list()[0]?.preview).toBe(
      undefined,
    );
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
    const said = conv.append(
      record.id,
      BOT,
      { images: [], kind: "text", text: "hi" },
      {
        turn_id: "turn_x",
      },
    );

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

    const request = conv.send(a.id, BOT, {
      kind: "secret_request",
      label: "2FA code",
      prompt: "Which?",
      provided: false,
    });
    expect(request.turn_ended).toBe(true);
    expect(request.conversation_id).toBe(a.id);
    expect(() => conv.send(a.id, BOT, { images: [], kind: "text", text: "more" })).toThrow(
      /turn ended/,
    );
    // The other chat is untouched: one Bot, two conversations, two turns.
    expect(conv.send(b.id, BOT, { images: [], kind: "text", text: "hi" }).turn_ended).toBe(false);
    // And a person speaking re-opens the turn that ended.
    conv.append(a.id, HUMAN, { kind: "human", text: "yes" });
    expect(conv.send(a.id, BOT, { images: [], kind: "text", text: "ok" }).turn_ended).toBe(false);
  });

  it("resolves one seat conversation per Bot, and the same one every time", () => {
    const conv = registry();
    const seat = conv.resolveSeat("main");
    expect(seat.route).toEqual({ kind: "seat" });
    expect(conv.resolveSeat("main").id).toBe(seat.id);
    // A Bot re-created under a name it had before adopts what it left
    // behind, because a conversation is resolved by route, not by roster row.
    expect(conv.resolveSeat("night").id).not.toBe(seat.id);
  });

  it("imports the old occurrence log once, at its own seq numbers", () => {
    const conv = registry();
    const seat = conv.resolveSeat("main");
    const written = conv.importSeatLog(seat.id, TRANSCRIPT, [
      { at: 1, id: "occ_1", images: [], kind: "text", seq: 1, text: "one" },
      { at: 2, id: "occ_2", kind: "human", seq: 2, text: "two" },
    ]);
    expect(written).toBe(2);
    const page = conv.page(seat.id);
    // seq and id are carried through untouched: a cursor held across the
    // deploy has to keep meaning what it meant.
    expect(page.entries.map((e) => [e.seq, e.id])).toEqual([
      [1, "occ_1"],
      [2, "occ_2"],
    ]);
    // The log recorded no author, so it is derived from the kind.
    expect(page.entries.map((e) => e.author)).toEqual([
      { bot: "main", kind: "bot" },
      { kind: "human", ref: "seat" },
    ]);
    // The next send continues the numbering rather than restarting it.
    expect(conv.append(seat.id, BOT, { images: [], kind: "text", text: "three" }).seq).toBe(3);
    expect(conv.byId(seat.id).imported_from).toBe(TRANSCRIPT);

    // Marked, so it never reads the file again.
    expect(
      conv.importSeatLog(seat.id, TRANSCRIPT, [
        { at: 4, id: "occ_4", images: [], kind: "text", seq: 4, text: "four" },
      ]),
    ).toBe(0);
    expect(conv.page(seat.id).entries).toHaveLength(3);
  });

  it("resumes a half-written import instead of duplicating it", () => {
    const store = new MemoryConversationStore();
    const log = new MemoryMessageLog();
    const lines: Occurrence[] = [
      { at: 1, id: "occ_1", images: [], kind: "text", seq: 1, text: "one" },
      { at: 2, id: "occ_2", images: [], kind: "text", seq: 2, text: "two" },
      { at: 3, id: "occ_3", images: [], kind: "text", seq: 3, text: "three" },
    ];
    // A crash partway through the import: two lines landed and the marker
    // never did. The two Fly volumes hold the only copy of this file, so a
    // second attempt has to be a resume and never a second copy.
    const crashed = new ConversationRegistry(store, log);
    const seat = crashed.resolveSeat("main");
    crashed.importSeatLog(seat.id, TRANSCRIPT, lines.slice(0, 2));
    store.save(store.load().map((c) => ({ ...c, imported_from: undefined })));

    const retried = new ConversationRegistry(store, log);
    expect(retried.importSeatLog(seat.id, TRANSCRIPT, lines)).toBe(1);
    expect(retried.page(seat.id).entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("carries a turn that ended in the imported log", () => {
    const conv = registry();
    const seat = conv.resolveSeat("main");
    conv.importSeatLog(seat.id, TRANSCRIPT, [
      {
        at: 1,
        id: "occ_w",
        kind: "secret_request",
        label: "2FA code",
        prompt: "Which?",
        provided: false,
        seq: 1,
      },
    ]);
    // The human was being waited on before the deploy and still is: a
    // restart is not a way for the agent to talk again.
    expect(() => conv.send(seat.id, BOT, { images: [], kind: "text", text: "hi" })).toThrow(
      /turn ended/,
    );
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
