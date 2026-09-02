import { describe, expect, it, afterEach } from "vitest";
import { ComputerError } from "@computer/shared";
import { FakeDesk } from "../src/desk/fake.ts";
import { BotState, memoryId, parseMemory } from "../src/service/state.ts";
import { VoiceService } from "../src/service/voice.ts";
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

  /** Boots a hub over `desks`, so a second call is the same box with a new hub. */
  async function boot(desks: Map<number, FakeDesk>): Promise<Opened> {
    const h = await startHub({ desks });
    opened.push(h);
    return h;
  }

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
    for (const bot of h.hub.bots.all()) {
      await bot.voice.flushed();
    }

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

  it("the transcript outlives the hub process", async () => {
    const desks = new Map<number, FakeDesk>();
    const first = await boot(desks);
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
    await first.hub.bots.byId("main").voice.flushed();
    await first.close();
    opened.pop();

    // Same box, new hub: what the phone asks for next is the same thread.
    const second = await boot(desks);
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
    const first = await boot(desks);
    await rpc(
      first.url,
      "/computer.v1.Agent/SendMessage",
      { kind: "widget", options: ["a", "b"], prompt: "Which?" },
      first.agent,
    );
    await first.hub.bots.byId("main").voice.flushed();
    await first.close();
    opened.pop();

    // The human is still being waited on. Crashing is not a way to talk again.
    const second = await boot(desks);
    await expect(
      rpc(
        second.url,
        "/computer.v1.Agent/SendMessage",
        { kind: "text", text: "never mind" },
        second.agent,
      ),
    ).rejects.toThrow(/turn ended/);
  });

  it("deleting a Bot keeps its transcript and memory; re-creating adopts them", async () => {
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
    await night.voice.flushed();
    await night.desk.writeFile(
      night.state.memoryPath,
      "- (2026-09-01) [note] the wifi drops at 3am\n",
    );

    await rpc(h.url, "/computer.v1.Seat/DeleteBot", { id: "night" }, seat);
    const desk = h.desks.get(2)!;
    // A roster row is not a human's record of what happened on their computer.
    expect(desk.files.has("/workspace/.bots/night/transcript.jsonl")).toBe(true);
    expect(desk.files.has("/workspace/.bots/night/memory/profile.md")).toBe(true);

    await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "night" }, seat);
    const reborn = h.hub.bots.byId("night");
    const kept = reborn.voice.page().entries;
    expect(kept.map((e) => (e.kind === "text" ? e.text : e.kind))).toEqual(["worked all night"]);
    const memory = await reborn.state.memory();
    expect(memory.map((m) => m.text)).toEqual(["the wifi drops at 3am"]);
  });

  it("a box that will not answer costs the tail of the log, not the voice", async () => {
    const desks = new Map<number, FakeDesk>([[1, new DeadBoxDesk({ display: 1 })]]);
    const h = await boot(desks);
    const r = (await rpc(
      h.url,
      "/computer.v1.Agent/SendMessage",
      { kind: "text", text: "still speaking" },
      h.agent,
    )) as { occurrence_id: string };
    expect(r.occurrence_id).toBeTruthy();
    await h.hub.bots.byId("main").voice.flushed();
    expect(h.hub.bots.byId("main").voice.page().entries).toHaveLength(1);
  });
});

describe("the voice's transcript store", () => {
  it("does not write until it has read: two runs must not both number from 1", async () => {
    const desk = new FakeDesk();
    const state = new BotState(desk, "main");
    const unrestored = new VoiceService(desk, undefined, state);
    await unrestored.send({ kind: "text", text: "before boot finished" });
    await unrestored.flushed();
    expect(desk.files.has(state.transcriptPath)).toBe(false);

    const restored = new VoiceService(desk, undefined, state);
    restored.restore([]);
    await restored.send({ kind: "text", text: "after" });
    await restored.flushed();
    expect(desk.files.get(state.transcriptPath)!.content.trim().split("\n")).toHaveLength(1);
  });

  it("skips a torn line rather than losing the bubbles before it", async () => {
    const desk = new FakeDesk();
    const state = new BotState(desk, "main");
    await desk.writeFile(
      state.transcriptPath,
      `{"id":"occ_1","seq":1,"at":1,"kind":"text","text":"kept","images":[]}\n{"id":"occ_2","seq":2,`,
    );
    const loaded = await state.loadTranscript();
    expect(loaded.map((o) => o.seq)).toEqual([1]);
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
