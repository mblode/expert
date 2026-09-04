import { afterEach, describe, expect, it, vi } from "vitest";

const generateObject = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ generateObject }));

const { templateChannel } = await import("./template.ts");
const { EVE_HUB_SECRET_HEADER } = await import("../auth.ts");

/**
 * The door and the shape, not the model's taste.
 *
 * What a good rewrite reads like is the model's judgement and cannot be
 * asserted here. What can be, and is what would hurt if it broke: that this
 * route is reachable only by the hub on loopback, that the whole setup is put
 * in front of the model rather than a summary of it, and that a generation
 * which fails comes back as a failure rather than as a half-rewritten
 * document, which would read as clean and not be.
 */
describe("a Bot rewriting its own setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    generateObject.mockReset();
  });

  const TEMPLATE = {
    description: "Runs personal ops for Blode.",
    instructions: "Draft replies in Matt's voice.",
    name: "Chief of Staff",
    routines: [{ id: "morning-brief", prompt: "Write Matt's brief.", title: "Brief" }],
    skills: [
      { body: "Open Matt's week view.", id: "calendar", name: "Calendar", use_when: "Use when." },
    ],
    title: "personal ops",
  };

  const route = () => {
    const channel = templateChannel({ model: "openai/gpt-5" }) as unknown as {
      routes: { handler: (req: Request, ctx: unknown) => Promise<Response> }[];
    };
    const handler = channel.routes[0]?.handler;
    if (!handler) {
      throw new Error("the template channel has no route");
    }
    return (headers: Record<string, string>, body: unknown) =>
      handler(
        new Request("http://127.0.0.1/eve/v1/template/generic", {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json", ...headers },
          method: "POST",
        }),
        {},
      );
  };

  it("answers only the hub, on the secret the hub injects", async () => {
    vi.stubEnv("COMPUTER_EVE_SECRET", "hub-secret");
    const call = route();
    const missing = await call({}, { template: TEMPLATE });
    const wrong = await call({ [EVE_HUB_SECRET_HEADER]: "wrong" }, { template: TEMPLATE });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("is closed when this computer has no hub secret at all", async () => {
    vi.stubEnv("COMPUTER_EVE_SECRET", "");
    const res = await route()({ [EVE_HUB_SECRET_HEADER]: "anything" }, { template: TEMPLATE });
    expect(res.status).toBe(503);
  });

  it("puts the whole setup in front of the model and answers with the rewrite", async () => {
    vi.stubEnv("COMPUTER_EVE_SECRET", "hub-secret");
    generateObject.mockResolvedValue({
      object: { dropped: "", name: "Chief of Staff", routines: [], skills: [] },
    });
    const res = await route()({ [EVE_HUB_SECRET_HEADER]: "hub-secret" }, { template: TEMPLATE });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Chief of Staff" });

    const call = generateObject.mock.calls[0]?.[0] as { model: string; prompt: string };
    expect(call.model).toBe("openai/gpt-5");
    // Bodies whole, not excerpted: the model is rewriting them, so a summary
    // would be a rewrite of a summary.
    expect(call.prompt).toContain("Open Matt's week view.");
    expect(call.prompt).toContain("Write Matt's brief.");
    expect(call.prompt).toContain("id: calendar");
  });

  it("fails rather than answering with something half rewritten", async () => {
    vi.stubEnv("COMPUTER_EVE_SECRET", "hub-secret");
    generateObject.mockRejectedValue(new Error("gateway is down"));
    const res = await route()({ [EVE_HUB_SECRET_HEADER]: "hub-secret" }, { template: TEMPLATE });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "gateway is down" });
  });

  it("refuses a request that carries no template", async () => {
    vi.stubEnv("COMPUTER_EVE_SECRET", "hub-secret");
    const res = await route()({ [EVE_HUB_SECRET_HEADER]: "hub-secret" }, { nothing: true });
    expect(res.status).toBe(400);
  });
});
