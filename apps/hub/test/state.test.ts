import { describe, expect, it, afterEach } from "vitest";
import { ComputerError } from "@computer/shared";
import { FakeDesk } from "../src/desk/fake.ts";
import { BotState, memoryId, parseMemory } from "../src/service/state.ts";
import type { Occurrence } from "../src/service/state.ts";
import { MemoryConversationStore, MemoryMessageLog } from "../src/service/conversations.ts";
import { rpc, startHub } from "./helper.ts";

type Opened = Awaited<ReturnType<typeof startHub>>;

/** The box that answers nothing: every file call fails, as when the desk is gone. */
class DeadBoxDesk extends FakeDesk {
  async readFile(): Promise<string> {
    throw new ComputerError("DAEMON_DOWN", "no such container");
  }
  async writeFile(): Promise<number> {
    throw new ComputerError("DAEMON_DOWN", "no such container");
  }
  async appendFile(): Promise<number> {
    throw new ComputerError("DAEMON_DOWN", "no such container");
  }
}

describe("per-Bot state on the box", () => {
  const opened: Opened[] = [];
  afterEach(async () => {
    while (opened.length) {
      await opened.pop()!.close();
    }
  });

  /**
   * Boots a hub over `desks`, so a second call is the same box with a new
   * hub. Pass `record` to keep the hub's own conversation files across the
   * two boots, which is what a Fly volume is.
   */
  async function boot(desks: Map<number, FakeDesk>, record?: Record): Promise<Opened> {
    const h = await startHub({
      conversationStore: record?.store,
      desks,
      messageLog: record?.log,
    });
    opened.push(h);
    return h;
  }

  interface Record {
    store: MemoryConversationStore;
    log: MemoryMessageLog;
  }

  const volume = (): Record => ({
    log: new MemoryMessageLog(),
    store: new MemoryConversationStore(),
  });

  it("gives every Bot a directory under /workspace, which survives a rebuild", async () => {
    const h = await boot(new Map());
    const paths = [...h.desk.files.keys()];
    expect(paths).toContain("/workspace/.bots/main/profile.json");
    expect(paths).toContain("/workspace/.bots/main/memory/profile.md");
    // Not ~/sand-data: $HOME is not on a volume here, so Grok's own location
    // would be erased by the next rebuild.
    expect(paths.every((p) => p.startsWith("/workspace/"))).toBe(true);
  });

  it("seeds a profile with Grok's fields and never overwrites one that exists", async () => {
    const desks = new Map<number, FakeDesk>();
    const h = await boot(desks);
    const profile = JSON.parse(h.desk.files.get("/workspace/.bots/main/profile.json")!.content);
    expect(profile).toMatchObject({ description: "", id: "main", name: "main", title: "" });
    expect(profile.avatar_shape).toBeTruthy();
    expect(profile.avatar_color).toMatch(/^#[0-9a-f]{6}$/);

    // The agent renamed itself. A hub restart must not undo that.
    await h.desk.writeFile(
      "/workspace/.bots/main/profile.json",
      JSON.stringify({ ...profile, name: "Ada", title: "night shift" }),
    );
    await boot(desks);
    const after = JSON.parse(h.desk.files.get("/workspace/.bots/main/profile.json")!.content);
    expect(after.name).toBe("Ada");
    expect(await h.hub.bots.byId("main").state.prompt()).toContain("You are Ada, night shift.");
  });

  it("keeps every token off the box", async () => {
    const h = await boot(new Map());
    const seat = await h.pair();
    await rpc(h.url, "/computer.v1.Agent/SendMessage", { kind: "text", text: "hello" }, h.agent);
    const created = (await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "night" }, seat)) as {
      token: string;
    };
    // Everything the box holds: names and contents of every file on every screen.
    const box = [...h.desks.values()].flatMap((d) =>
      [...d.files.entries()].map(([path, f]) => `${path}\n${f.content}`),
    );
    const blob = box.join("\n");
    for (const token of [h.agent, seat, created.token]) {
      expect(token.length).toBeGreaterThan(8);
      expect(blob).not.toContain(token);
    }
  });

  it("the thread outlives the hub process", async () => {
    const desks = new Map<number, FakeDesk>();
    const record = volume();
    const first = await boot(desks, record);
    const seat = await first.pair();
    await rpc(
      first.url,
      "/computer.v1.Agent/SendMessage",
      { kind: "text", text: "on it" },
      first.agent,
    );
    await rpc(
      first.url,
      "/computer.v1.Agent/SendMessage",
      { kind: "text", text: "done" },
      first.agent,
    );
    await first.close();
    opened.pop();

    // Same box, new hub: what the phone asks for next is the same thread.
    const second = await boot(desks, record);
    const page = (await rpc(
      second.url,
      "/computer.v1.Seat/Occurrences",
      {},
      await second.pair(),
    )) as {
      entries: { seq: number; text: string }[];
    };
    expect(page.entries.map((e) => e.text)).toEqual(["on it", "done"]);
    expect(seat).toBeTruthy();

    // seq keeps counting, so a cursor the phone held still means what it meant.
    await rpc(
      second.url,
      "/computer.v1.Agent/SendMessage",
      { kind: "text", text: "and again" },
      second.agent,
    );
    const next = (await rpc(
      second.url,
      "/computer.v1.Seat/Occurrences",
      { cursor: "2" },
      await second.pair(),
    )) as { entries: { seq: number; text: string }[] };
    expect(next.entries.map((e) => e.seq)).toEqual([3]);
    expect(next.entries[0]!.text).toBe("and again");
  });

  it("a turn that ended before the restart is still ended after it", async () => {
    const desks = new Map<number, FakeDesk>();
    const record = volume();
    const first = await boot(desks, record);
    await rpc(
      first.url,
      "/computer.v1.Agent/SendMessage",
      { kind: "widget", options: ["a", "b"], prompt: "Which?" },
      first.agent,
    );
    await first.close();
    opened.pop();

    // The human is still being waited on. Crashing is not a way to talk again.
    const second = await boot(desks, record);
    await expect(
      rpc(
        second.url,
        "/computer.v1.Agent/SendMessage",
        { kind: "text", text: "never mind" },
        second.agent,
      ),
    ).rejects.toThrow(/turn ended/);
  });

  it("deleting a Bot keeps its thread and memory; re-creating adopts them", async () => {
    const h = await boot(new Map());
    const seat = await h.pair();
    await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "night" }, seat);
    const night = h.hub.bots.byId("night");
    await rpc(
      h.url,
      "/computer.v1.Agent/SendMessage",
      { kind: "text", text: "worked all night" },
      night.token,
    );
    await night.desk.writeFile(
      night.state.memoryPath,
      "- (2026-09-01) [note] the wifi drops at 3am\n",
    );

    await rpc(h.url, "/computer.v1.Seat/DeleteBot", { id: "night" }, seat);
    // A roster row is not a human's record of what happened on their
    // computer: the memory file stays on the box, and the thread stays in
    // the hub's own files, where the Bot could not have reached it anyway.
    expect(h.desks.get(2)!.files.has("/workspace/.bots/night/memory/profile.md")).toBe(true);
    expect(h.hub.conversations.list().some((c) => c.bot === "night")).toBe(true);

    await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "night" }, seat);
    const reborn = h.hub.bots.byId("night");
    const kept = reborn.voice.entries();
    expect(kept.map((e) => (e.kind === "text" ? e.text : e.kind))).toEqual(["worked all night"]);
    const memory = await reborn.state.memory();
    expect(memory.map((m) => m.text)).toEqual(["the wifi drops at 3am"]);
  });

  it("a box that will not answer costs the box's own state, not the voice", async () => {
    const desks = new Map<number, FakeDesk>([[1, new DeadBoxDesk({ display: 1 })]]);
    const h = await boot(desks);
    const r = (await rpc(
      h.url,
      "/computer.v1.Agent/SendMessage",
      { kind: "text", text: "still speaking" },
      h.agent,
    )) as { occurrence_id: string };
    expect(r.occurrence_id).toBeTruthy();
    // The thread is one of the hub's own files now, so a desk that will not
    // answer does not even cost the tail of it.
    expect(h.hub.bots.byId("main").voice.entries()).toHaveLength(1);
  });
});

/**
 * The only real migration in this design is data: `transcript.jsonl` is live
 * on two Fly volumes and it is the only copy of what these computers have
 * said. So the import is checked for the two things that would lose it,
 * running twice and running over a box that was not answering.
 */
describe("the one-shot transcript import", () => {
  const opened: Opened[] = [];
  afterEach(async () => {
    while (opened.length) {
      await opened.pop()!.close();
    }
  });

  const LINES: Occurrence[] = [
    { at: 1, id: "occ_one", images: [], kind: "text", seq: 1, text: "before conversations" },
    { at: 2, id: "occ_two", kind: "human", seq: 2, text: "thanks" },
    { at: 3, id: "occ_three", images: [], kind: "text", seq: 3, text: "any time" },
  ];

  const TRANSCRIPT = "/workspace/.bots/main/transcript.jsonl";

  /** A box whose volume already holds a Bot's pre-conversations log. */
  function boxWith(lines: Occurrence[]): { desks: Map<number, FakeDesk>; file: string } {
    const desk = new FakeDesk({ display: 1 });
    const file = `${lines.map((o) => JSON.stringify(o)).join("\n")}\n`;
    desk.files.set(TRANSCRIPT, { content: file });
    return { desks: new Map([[1, desk]]), file };
  }

  async function boot(
    desks: Map<number, FakeDesk>,
    store: MemoryConversationStore,
    log: MemoryMessageLog,
  ): Promise<Opened> {
    const h = await startHub({ conversationStore: store, desks, messageLog: log });
    opened.push(h);
    return h;
  }

  it("imports the old log once, at the same seq, and never writes it again", async () => {
    const { desks, file } = boxWith(LINES);
    const store = new MemoryConversationStore();
    const log = new MemoryMessageLog();

    const first = await boot(desks, store, log);
    const page = (await rpc(
      first.url,
      "/computer.v1.Seat/Occurrences",
      {},
      await first.pair(),
    )) as {
      entries: { seq: number; kind: string; text: string; author: { kind: string } }[];
    };
    // The same entries at the same seq values as before the deploy, which is
    // the whole promise: a cursor still means what it meant.
    expect(page.entries.map((e) => [e.seq, e.text])).toEqual([
      [1, "before conversations"],
      [2, "thanks"],
      [3, "any time"],
    ]);
    // The occurrence log recorded no author, so it is derived from the kind.
    expect(page.entries.map((e) => e.author.kind)).toEqual(["bot", "human", "bot"]);

    // The next send continues the numbering rather than restarting it.
    await rpc(
      first.url,
      "/computer.v1.Agent/SendMessage",
      { kind: "text", text: "now" },
      first.agent,
    );
    expect(first.hub.bots.byId("main").voice.entries().at(-1)!.seq).toBe(4);
    await first.close();
    opened.pop();

    // A second boot over the same volume imports nothing: the marker on the
    // record says the file has already been read.
    const second = await boot(desks, store, log);
    const after = (await rpc(
      second.url,
      "/computer.v1.Seat/Occurrences",
      {},
      await second.pair(),
    )) as { entries: { seq: number }[] };
    expect(after.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    // And the source is byte-for-byte what it was: read once, never written,
    // and deliberately not deleted.
    expect(desks.get(1)!.files.get(TRANSCRIPT)!.content).toBe(file);
    expect(store.load()[0]!.imported_from).toBe(TRANSCRIPT);
  });

  it("carries a turn that ended in the old log across the import", async () => {
    const { desks } = boxWith([
      {
        answer: null,
        at: 1,
        id: "occ_w",
        kind: "widget",
        options: ["a", "b"],
        prompt: "Which?",
        seq: 1,
      },
    ]);
    const h = await boot(desks, new MemoryConversationStore(), new MemoryMessageLog());
    // The human was being waited on before the deploy, and still is.
    await expect(
      rpc(h.url, "/computer.v1.Agent/SendMessage", { kind: "text", text: "never mind" }, h.agent),
    ).rejects.toThrow(/turn ended/);
  });

  it("is retried, not marked done, over a box that would not answer", async () => {
    const store = new MemoryConversationStore();
    const log = new MemoryMessageLog();
    const first = await boot(
      new Map<number, FakeDesk>([[1, new DeadBoxDesk({ display: 1 })]]),
      store,
      log,
    );
    // Nothing imported, and nothing claimed to have been.
    expect(first.hub.bots.byId("main").voice.entries()).toEqual([]);
    expect(store.load()[0]!.imported_from).toBeUndefined();
    await first.close();
    opened.pop();

    // The box comes back, with the file that was there all along.
    const second = await boot(boxWith(LINES).desks, store, log);
    expect(
      second.hub.bots
        .byId("main")
        .voice.entries()
        .map((e) => e.seq),
    ).toEqual([1, 2, 3]);
  });
});

describe("the transcript file", () => {
  it("skips a torn line rather than losing the bubbles before it", async () => {
    const desk = new FakeDesk();
    const state = new BotState(desk, "main");
    await desk.writeFile(
      state.transcriptPath,
      `{"id":"occ_1","seq":1,"at":1,"kind":"text","text":"kept","images":[]}\n{"id":"occ_2","seq":2,`,
    );
    const loaded = await state.readTranscript();
    expect(loaded?.map((o) => o.seq)).toEqual([1]);
  });

  it("answers unknown, not empty, when the file cannot be read at all", async () => {
    // The import marks itself done off the back of this, so a box that will
    // not answer and a Bot that never spoke must not look the same.
    expect(await new BotState(new DeadBoxDesk(), "main").readTranscript()).toBeUndefined();
    expect(await new BotState(new FakeDesk(), "main").readTranscript()).toBeUndefined();
  });
});

describe("memory", () => {
  it("reads dated fact lines and ignores everything else", () => {
    const entries = parseMemory(
      [
        "# Memory",
        "",
        "Some prose that is not a fact.",
        "- (2026-09-01) [note] prefers the terminal over the GUI",
        "- (2026-09-02) [episode] reinstalled ripgrep after a rebuild",
        "- (2026-09-03) no prefix means a note",
        "- not dated, so not a fact",
      ].join("\n"),
    );
    expect(entries.map((e) => [e.date, e.kind, e.text])).toEqual([
      ["2026-09-01", "note", "prefers the terminal over the GUI"],
      ["2026-09-02", "episode", "reinstalled ripgrep after a rebuild"],
      ["2026-09-03", "note", "no prefix means a note"],
    ]);
  });

  it("identifies a fact by its content, so writing it twice keeps one", () => {
    const entries = parseMemory(
      [
        "- (2026-09-01) [note] The  wifi drops at 3am",
        "- (2026-09-04) [note] the wifi drops at 3AM",
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(memoryId("the wifi drops at 3am"));
    expect(entries[0]!.id).toHaveLength(16);
  });

  it("truncates an over-long line instead of dropping the fact", () => {
    const [entry] = parseMemory(`- (2026-09-01) [note] ${"x".repeat(900)}`);
    expect(entry!.text).toHaveLength(500);
  });

  it("hands the agent its memory and the path to add to it", async () => {
    const desk = new FakeDesk();
    const state = new BotState(desk, "night");
    await state.init();
    await desk.writeFile(state.memoryPath, "- (2026-09-01) [note] the wifi drops at 3am\n");
    const prompt = await state.prompt();
    expect(prompt).toContain("You are night.");
    expect(prompt).toContain("/workspace/.bots/night/memory/profile.md");
    expect(prompt).toContain("- (2026-09-01) [note] the wifi drops at 3am");
  });
});
