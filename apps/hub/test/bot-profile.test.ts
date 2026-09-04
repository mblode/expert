import { afterEach, describe, expect, it } from "vitest";
import { FakeDesk } from "../src/desk/fake.ts";
import { rpc, startHub } from "./helper.ts";

type Opened = Awaited<ReturnType<typeof startHub>>;

const PROFILE = "/workspace/.bots/main/profile.json";

interface Profile {
  id: string;
  name: string;
  title: string;
  description: string;
  avatar_shape: string;
  avatar_color: string;
}

async function roster(url: string, token: string): Promise<{ id: string; profile: Profile }[]> {
  const res = await fetch(`${url}/roster`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await res.json()) as { bots: { id: string; profile: Profile }[] };
  return body.bots;
}

/**
 * The profile is the one piece of per-Bot state a human edits and the model
 * reads back as its own prompt, so the tests here are about the two ends of
 * that: what a seat may write, and what the hub is willing to hand out again
 * from a file the agent can rewrite itself.
 */
describe("a Bot's profile", () => {
  const opened: Opened[] = [];
  afterEach(async () => {
    while (opened.length) {
      await opened.pop()!.close();
    }
  });

  async function boot(desks = new Map<number, FakeDesk>()): Promise<Opened> {
    const h = await startHub({ desks });
    opened.push(h);
    return h;
  }

  it("carries the seeded profile on /roster beside the screen", async () => {
    const h = await boot();
    const [bot] = await roster(h.url, await h.pair());
    expect(bot?.id).toBe("main");
    expect(bot?.profile).toMatchObject({ description: "", id: "main", name: "main", title: "" });
    expect(bot?.profile.avatar_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("writes what the human typed, and the Bot wakes up as that person", async () => {
    const h = await boot();
    const seat = await h.pair();
    const saved = (await rpc(
      h.url,
      "/computer.v1.Seat/SetBotProfile",
      {
        avatar_color: "#0091ff",
        avatar_shape: "diamond",
        description: "Keeps the deploys honest.",
        id: "main",
        name: "Ada",
        title: "night shift",
      },
      seat,
    )) as Profile;
    expect(saved).toEqual({
      avatar_color: "#0091ff",
      avatar_shape: "diamond",
      description: "Keeps the deploys honest.",
      id: "main",
      name: "Ada",
      title: "night shift",
    });

    // The point of the feature: an edit lands on the box, in the file the
    // Bot's own Eve reads at the start of every turn.
    expect(JSON.parse(h.desk.files.get(PROFILE)!.content)).toMatchObject({
      description: "Keeps the deploys honest.",
      name: "Ada",
      title: "night shift",
    });
    const [bot] = await roster(h.url, seat);
    expect(bot?.profile.name).toBe("Ada");
  });

  it("clears a title and a description, and keeps the id the caller asked for", async () => {
    const h = await boot();
    const seat = await h.pair();
    const write = (body: Record<string, unknown>) =>
      rpc(h.url, "/computer.v1.Seat/SetBotProfile", body, seat) as Promise<Profile>;
    await write({
      avatar_color: "#46a758",
      avatar_shape: "circle",
      description: "for now",
      id: "main",
      name: "Ada",
      title: "night shift",
    });
    // An empty string is how a form clears a field, and the two optional
    // fields are the only ones that may end up empty.
    const cleared = await write({
      avatar_color: "#46a758",
      avatar_shape: "circle",
      description: "",
      id: "main",
      name: "Ada",
      title: "",
    });
    expect(cleared).toMatchObject({ description: "", id: "main", title: "" });
    expect(await h.hub.bots.byId("main").state.profile()).toMatchObject({
      description: "",
      name: "Ada",
      title: "",
    });
  });

  it("refuses a mark outside the palette, an empty name and an unknown Bot", async () => {
    const h = await boot();
    const seat = await h.pair();
    const base = {
      avatar_color: "#0091ff",
      avatar_shape: "circle",
      description: "",
      id: "main",
      name: "Ada",
      title: "",
    };
    const refuse = async (body: Record<string, unknown>, code: string) => {
      await expect(rpc(h.url, "/computer.v1.Seat/SetBotProfile", body, seat)).rejects.toMatchObject(
        { code },
      );
    };
    // A colour reaches a client as an inline style, so it is a closed set
    // rather than a string the hub passes through.
    await refuse({ ...base, avatar_color: "url(javascript:alert(1))" }, "VALIDATION");
    await refuse({ ...base, avatar_shape: "trapezoid" }, "VALIDATION");
    await refuse({ ...base, name: "   " }, "VALIDATION");
    await refuse({ ...base, name: "x".repeat(49) }, "VALIDATION");
    await refuse({ ...base, description: "x".repeat(501) }, "VALIDATION");
    await refuse({ ...base, id: "nobody" }, "VALIDATION");

    // Nothing partial was written on the way to any of those.
    const [bot] = await roster(h.url, seat);
    expect(bot?.profile.name).toBe("main");
  });

  it("is an owner's edit: a guest seat cannot rename the Bot it is sitting at", async () => {
    const h = await boot();
    const owner = await h.pair();
    const { token } = (await rpc(
      h.url,
      "/computer.v1.Seat/Issue",
      { display: 1, role: "guest", subject: "someone@example.com", ttl_sec: 600 },
      owner,
    )) as { token: string };
    await expect(
      rpc(
        h.url,
        "/computer.v1.Seat/SetBotProfile",
        {
          avatar_color: "#0091ff",
          avatar_shape: "circle",
          description: "",
          id: "main",
          name: "Mallory",
          title: "",
        },
        token,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    // The roster is owner-only too, so a guest cannot even read the profile.
    const res = await fetch(`${h.url}/roster`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("a seat bound to one screen may not edit another screen's Bot", async () => {
    const h = await boot();
    const owner = await h.pair();
    await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "night" }, owner);
    const { token } = (await rpc(
      h.url,
      "/computer.v1.Seat/Issue",
      { display: 2, role: "owner", subject: "someone@example.com" },
      owner,
    )) as { token: string };
    await expect(
      rpc(
        h.url,
        "/computer.v1.Seat/SetBotProfile",
        {
          avatar_color: "#0091ff",
          avatar_shape: "circle",
          description: "",
          id: "main",
          name: "Mallory",
          title: "",
        },
        token,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  /**
   * `profile.json` is under `/workspace`, so the model's own `write_file`
   * reaches it: the hub validating writes is not enough on its own, because
   * the agent is not obliged to use the door. The read is therefore the
   * boundary that matters, and it clamps rather than trusts.
   */
  it("clamps a profile the agent wrote itself instead of handing it on", async () => {
    const desk = new FakeDesk({ display: 1 });
    const h = await boot(new Map([[1, desk]]));
    await rpc(
      h.url,
      "/computer.v1.Agent/WriteFile",
      {
        content: JSON.stringify({
          avatar_color: "expression(alert(1))",
          avatar_shape: "</span><script>",
          description: "d".repeat(900),
          id: "not-main",
          name: "n".repeat(200),
          title: 42,
        }),
        path: PROFILE,
      },
      h.agent,
    );
    const [bot] = await roster(h.url, await h.pair());
    expect(bot?.profile.avatar_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(["circle", "square", "hexagon", "diamond"]).toContain(bot?.profile.avatar_shape);
    expect(bot?.profile.name).toHaveLength(48);
    expect(bot?.profile.description).toHaveLength(500);
    // A non-string title is not a title, and the id is the hub's answer.
    expect(bot?.profile.title).toBe("");
    expect(bot?.profile.id).toBe("main");
  });
});
