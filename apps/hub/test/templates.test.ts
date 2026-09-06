import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { templateSources } from "../src/host/bot-template.ts";
import { FakeDesk } from "../src/desk/fake.ts";
import { rpc, startHub } from "./helper.ts";

type Opened = Awaited<ReturnType<typeof startHub>>;

interface Template {
  version: number;
  name: string;
  title: string;
  description: string;
  avatar_shape: string;
  avatar_color: string;
  instructions: string;
  memories: string[];
  skills: { id: string; name: string; use_when: string; body: string }[];
  routines: { id: string; title: string; cron: string; prompt: string }[];
  plugins: { name: string; url: string; auth: string }[];
}

const A_TEMPLATE = {
  avatar_color: "#0091ff",
  avatar_shape: "diamond",
  description: "Front of house.",
  instructions: "# Identity\n\nRoute work to the specialist and stay at the desk.",
  memories: ["the human is in Melbourne", "ship on Fridays"],
  name: "Chief of Staff",
  plugins: [{ auth: "oauth", name: "calendar", url: "https://mcp.example.com/calendar" }],
  routines: [
    {
      cron: "0 20 * * 0-4",
      id: "morning-brief",
      prompt: "Write today's brief.",
      title: "Morning brief",
    },
  ],
  skills: [
    {
      body: "# Calendar\n\nOpen the week view and read it.",
      id: "calendar",
      name: "Calendar",
      use_when: "Use when asked what their day looks like.",
    },
  ],
  title: "personal ops",
  version: 1,
};

/**
 * A template is the one thing on this computer that is authored somewhere
 * else. So the tests are about the two ends of that: what leaves a Bot when
 * its owner shares it, and what a document from a stranger is allowed to do
 * to a Bot on the computer that installs it.
 */
describe("a Bot template", () => {
  const opened: Opened[] = [];
  afterEach(async () => {
    while (opened.length) {
      await opened.pop()!.close();
    }
  });

  async function boot(): Promise<Opened> {
    const h = await startHub({ desks: new Map([[1, new FakeDesk({ display: 1 })]]) });
    opened.push(h);
    return h;
  }

  /** The RPC answers with the document plus whether a rewrite ran; these are about the document. */
  const exportFor = async (h: Opened, id: string, seat: string): Promise<Template> => {
    const answer = (await rpc(h.url, "/computer.v1.Seat/ExportBotTemplate", { id }, seat)) as {
      template: Template;
    };
    return answer.template;
  };

  const apply = (h: Opened, id: string, template: unknown, seat: string) =>
    rpc(h.url, "/computer.v1.Seat/ApplyBotTemplate", { id, template }, seat);

  /**
   * Applying a template is writing the files a Bot's own Eve reads at the
   * start of every turn (`apps/eve/lib/profile.ts`), so what this pins is
   * that they are on the box, at the paths that composer looks in, with the
   * document's contents in them.
   */
  it("writes a whole setup onto the Bot, where its next turn reads it", async () => {
    const h = await boot();
    const seat = await h.pair();
    await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "cos" }, seat);
    await apply(h, "cos", A_TEMPLATE, seat);

    const { state } = h.hub.bots.byId("cos");
    expect(await state.profile()).toMatchObject({ name: "Chief of Staff", title: "personal ops" });
    expect(await state.instructions()).toContain("Route work to the specialist");
    expect(await state.skills()).toMatchObject([
      { body: expect.stringContaining("week view"), id: "calendar", name: "Calendar" },
    ]);
    expect(state.skillBodyPath("calendar")).toBe("/workspace/.bots/cos/skills/calendar.md");
    expect(await state.routines()).toMatchObject([{ cron: "0 20 * * 0-4", id: "morning-brief" }]);
    expect(await state.plugins()).toMatchObject([{ auth: "oauth", name: "calendar" }]);
    expect(await state.memories()).toContain("the human is in Melbourne");
  });

  it("comes back out of the computer as what went in", async () => {
    const h = await boot();
    const seat = await h.pair();
    await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "cos" }, seat);
    await apply(h, "cos", A_TEMPLATE, seat);
    const exported = await exportFor(h, "cos", seat);
    expect(exported).toMatchObject({
      description: "Front of house.",
      instructions: A_TEMPLATE.instructions,
      name: "Chief of Staff",
      title: "personal ops",
      version: 1,
    });
    expect(exported.skills).toMatchObject([{ id: "calendar", name: "Calendar" }]);
    expect(exported.routines).toMatchObject([{ cron: "0 20 * * 0-4" }]);
    expect(exported.plugins).toMatchObject([{ name: "calendar" }]);
    // Memory travels as facts and not as dated episodes: it is being told to
    // the next Bot, not remembered by it.
    expect(exported.memories).toEqual(["the human is in Melbourne", "ship on Fridays"]);
  });

  /**
   * The document arrives over a link from a computer this one has never met,
   * its ids become filenames and its strings become a system prompt, so the
   * clamp is the feature rather than a detail of it.
   */
  it("clamps a hostile document instead of installing it", async () => {
    const h = await boot();
    const seat = await h.pair();
    await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "mallory" }, seat);
    await apply(
      h,
      "mallory",
      {
        avatar_color: "url(javascript:alert(1))",
        avatar_shape: "trapezoid",
        description: "d".repeat(900),
        instructions: `${"i".repeat(9000)}\u0000\u001B[31m`,
        memories: Array.from({ length: 400 }, (_, i) => `fact ${i}`),
        name: "n".repeat(200),
        plugins: [{ auth: "oauth", name: "evil", url: "data:text/html,<script>alert(1)</script>" }],
        routines: [
          { cron: "not a cron", id: "never", prompt: "x" },
          { cron: "0 20 * * *", id: "../../etc/cron", prompt: "y", title: "Escape" },
        ],
        skills: [{ body: "b", id: "../../../etc/passwd", name: "Escape" }],
        title: 42,
      },
      seat,
    );
    const { state } = h.hub.bots.byId("mallory");
    const profile = await state.profile();
    expect(profile.avatar_color).toMatch(/^#[0-9a-f]{6}$/u);
    expect(profile.name).toHaveLength(48);
    expect(profile.description).toHaveLength(500);
    // A non-string title is not a title.
    expect(profile.title).toBe("");

    const instructions = await state.instructions();
    expect(instructions).toHaveLength(8000);
    expect(instructions).not.toContain("\u001B");

    // An id is a path on this computer, so it is slugged here and never
    // taken from the document.
    const [skill] = await state.skills();
    expect(skill?.id).toBe("etc-passwd");
    expect(state.skillBodyPath(skill!.id)).toBe("/workspace/.bots/mallory/skills/etc-passwd.md");

    // A cron neither alarm can evaluate is a routine that silently never
    // runs, so it is dropped rather than carried.
    expect(await state.routines()).toMatchObject([{ cron: "0 20 * * *", id: "etc-cron" }]);

    // A plugin is a link on a page: the scheme is a closed set.
    expect(await state.plugins()).toMatchObject([{ name: "evil", url: "" }]);

    const memories = await state.memories();
    expect(memories).toHaveLength(100);
  });

  it("refuses a document that is not one, and a Bot that is not there", async () => {
    const h = await boot();
    const seat = await h.pair();
    await expect(apply(h, "main", { name: "  " }, seat)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(apply(h, "main", "a string", seat)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(exportFor(h, "nobody", seat)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("is an owner's edit: a guest at the screen can neither read it nor write it", async () => {
    const h = await boot();
    const owner = await h.pair();
    const { token } = (await rpc(
      h.url,
      "/computer.v1.Seat/Issue",
      { display: 1, role: "guest", subject: "someone@example.com", ttl_sec: 600 },
      owner,
    )) as { token: string };
    await expect(exportFor(h, "main", token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(apply(h, "main", A_TEMPLATE, token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("a seat bound to one screen may not export another screen's Bot", async () => {
    const h = await boot();
    const owner = await h.pair();
    await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "night" }, owner);
    const { token } = (await rpc(
      h.url,
      "/computer.v1.Seat/Issue",
      { display: 2, role: "owner", subject: "someone@example.com" },
      owner,
    )) as { token: string };
    await expect(exportFor(h, "main", token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(exportFor(h, "night", token)).resolves.toMatchObject({ name: "night" });
  });

  /**
   * A Bot that came with the build keeps its brief, its skills and its
   * schedule in git, so without the project reader the one Bot this
   * computer ships would export as a name and a paragraph. Read against the
   * real project: what makes this honest is that it is the same tree the
   * guest image builds.
   */
  it("reads what a shipped Bot's Eve project holds", () => {
    const root = join(import.meta.dirname, "../../eve/bots");
    const source = templateSources(root)("main");
    expect(source?.instructions).toContain("#");
    expect(source?.skills.map((s) => s.id)).toContain("calendar");
    const calendar = source?.skills.find((s) => s.id === "calendar");
    expect(calendar?.use_when.startsWith("Use when")).toBe(true);
    expect(calendar?.body).toContain("# Calendar");
    // Two files declare a routine and both are read: the cron out of
    // routines.json, the prompt out of the schedule module beside it.
    expect(source?.routines).toMatchObject([{ cron: "0 20 * * *", id: "box-health" }]);
    expect(source?.routines[0]?.prompt).toContain("A daily check on my own computer");
    // A connection that is only wiring, with no address of its own, is not a
    // service a person installing this would have to connect.
    expect(source?.plugins).toEqual([]);
  });

  it("is nothing for a project that is not there", () => {
    expect(templateSources("/nowhere")("ghost")).toBeUndefined();
  });

  /**
   * Box wins where both answer, the same rule the profile follows: a Bot that
   * shipped with a brief and was then rewritten shares what it is now.
   */
  it("prefers what the human changed on the box over what the project shipped", async () => {
    const h = await boot();
    const seat = await h.pair();
    const { state } = h.hub.bots.byId("main");
    await state.setInstructions("Rewritten on the box.");
    const exported = await exportFor(h, "main", seat);
    expect(exported.instructions).toBe("Rewritten on the box.");
  });
});
