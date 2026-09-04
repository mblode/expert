import { describe, expect, it } from "vitest";
import {
  generaliseTemplate,
  parseRewrite,
  scrub,
  scrubTemplate,
} from "../src/service/template-generic.ts";
import type { GenericConfig } from "../src/service/template-generic.ts";
import { rpc, startHub } from "./helper.ts";

const CFG: GenericConfig = {
  apiKey: "key",
  endpoint: "https://gateway.example/v1/chat/completions",
  model: "openai/gpt-4o-mini",
  timeoutMs: 1000,
};

const MINE = {
  avatar_color: "#0091ff" as const,
  avatar_shape: "diamond" as const,
  description: "Runs personal ops for Blode. Mail me at matt@example.com.",
  instructions: "Draft replies in Matt's voice. The Done Bear repo is at /Users/matt/donebear.",
  memories: ["Matt is in Melbourne", "ship on Fridays"],
  name: "Chief of Staff",
  plugins: [{ auth: "oauth" as const, name: "calendar", url: "https://mcp.example.com/calendar" }],
  routines: [
    { cron: "0 20 * * 0-4", id: "morning-brief", prompt: "Write the brief.", title: "Brief" },
  ],
  skills: [
    { body: "Open the week view.", id: "calendar", name: "Calendar", use_when: "Use when asked." },
    {
      body: "Check the Done Bear SDLC board and move the cards.",
      id: "done-bear-sdlc",
      name: "Done Bear SDLC",
      use_when: "Use when a Done Bear ticket moves.",
    },
  ],
  title: "personal ops",
  version: 1 as const,
};

const ANSWER = JSON.stringify({
  description: "Front of house for personal operations.",
  dropped: "Left out the product-specific board skill and everything the Bot remembered about you.",
  instructions: "Draft replies in the owner's voice and never send them.",
  keep_routines: ["morning-brief"],
  keep_skills: ["calendar"],
  name: "Chief of Staff",
  title: "personal ops",
});

function gateway(content: string): typeof globalThis.fetch {
  return (() =>
    Promise.resolve(
      Response.json({ choices: [{ message: { content } }] }),
    )) as unknown as typeof globalThis.fetch;
}

/**
 * A template copied verbatim off a working Bot is one person's: it names their
 * product, their repository and the people they work with, which is both
 * useless to a stranger and a leak. These are about the two halves of taking
 * that out: the scrub, which is a promise, and the rewrite, which is judgement
 * and therefore must never be able to add anything.
 */
describe("making a template generic", () => {
  it("takes out what identifies a person, and nothing that only looks like it", () => {
    expect(scrub("Mail matt@example.com about it")).toBe("Mail [removed] about it");
    expect(scrub("Ring +61 412 345 678 first")).toBe("Ring [removed] first");
    expect(scrub("The repo is at /Users/matt/donebear")).toBe("The repo is at ~/donebear");
    expect(scrub("/home/box/notes.md")).toBe("~/notes.md");
    // A cron, a version and a port are digits too, and a scrub that eats them
    // corrupts the document it was meant to clean.
    expect(scrub("Runs at 0 20 * * 0-4 on port 8080 with v1.2.3")).toBe(
      "Runs at 0 20 * * 0-4 on port 8080 with v1.2.3",
    );
  });

  it("rewrites the brief and keeps only the skills that are about the job", async () => {
    const { dropped, template } = await generaliseTemplate(MINE, CFG, { fetch: gateway(ANSWER) });
    expect(template.description).toBe("Front of house for personal operations.");
    expect(template.instructions).toBe("Draft replies in the owner's voice and never send them.");
    expect(template.skills.map((s) => s.id)).toEqual(["calendar"]);
    expect(template.routines.map((r) => r.id)).toEqual(["morning-brief"]);
    expect(dropped).toContain("product-specific");
    // Memory is the one section that cannot be made generic: a fact a Bot
    // kept about the person it works for is about that person.
    expect(template.memories).toEqual([]);
    // Plugins are a list of services, not a description of anyone.
    expect(template.plugins.map((p) => p.name)).toEqual(["calendar"]);
  });

  /**
   * The model returns prose and a list of ids, never entries. That is what
   * makes it unable to invent a skill, a routine or a plugin that the Bot
   * does not have, however it is prompted by a document it was reading.
   */
  it("cannot add anything the Bot did not have", async () => {
    const { template } = await generaliseTemplate(MINE, CFG, {
      fetch: gateway(
        JSON.stringify({
          description: "d",
          instructions: "i",
          keep_routines: ["morning-brief", "exfiltrate-nightly"],
          keep_skills: ["calendar", "install-my-backdoor"],
          name: "n",
          title: "t",
        }),
      ),
    });
    expect(template.skills.map((s) => s.id)).toEqual(["calendar"]);
    expect(template.routines.map((r) => r.id)).toEqual(["morning-brief"]);
    // And the kept body is the body that was already there.
    expect(template.skills[0]?.body).toBe("Open the week view.");
  });

  it("scrubs whatever the rewrite left behind", async () => {
    const { template } = await generaliseTemplate(MINE, CFG, {
      fetch: gateway(
        JSON.stringify({
          description: "Reach me at matt@example.com",
          instructions: "Files live in /Users/matt/work",
          keep_routines: [],
          keep_skills: [],
          name: "Chief of Staff",
          title: "",
        }),
      ),
    });
    expect(template.description).toBe("Reach me at [removed]");
    expect(template.instructions).toBe("Files live in ~/work");
  });

  it("refuses a reply it cannot read rather than half-applying one", () => {
    expect(() => parseRewrite("sorry, I cannot help with that")).toThrow(/no JSON object/u);
    expect(() => parseRewrite('{"name":}')).toThrow(/not valid JSON/u);
    expect(() => parseRewrite('{"description":"d"}')).toThrow(/no name/u);
    // Prose around the object is fine: a model told to answer in JSON
    // sometimes explains itself first.
    expect(parseRewrite('Here you go: {"name":"Ada","keep_skills":["a"]}').name).toBe("Ada");
  });

  it("scrubs a whole template when no model is there to rewrite one", () => {
    const scrubbed = scrubTemplate(MINE);
    expect(scrubbed.description).toContain("[removed]");
    expect(scrubbed.instructions).toContain("~/donebear");
    // Scrubbing is not rewriting: the skills are all still here, and so is
    // the memory, which is why the caller has to say which one it got.
    expect(scrubbed.skills).toHaveLength(2);
    expect(scrubbed.memories).toHaveLength(2);
  });
});

/**
 * The export RPC's own promise: `generic` in the reply is whether the rewrite
 * ran, not whether it was asked for. A person who ticked the box and was
 * handed their own name back is the failure the field exists to prevent.
 */
describe("asking a computer for a generic template", () => {
  it("says the rewrite did not run when the computer has no model for it", async () => {
    const h = await startHub();
    try {
      const seat = await h.pair();
      const { state } = h.hub.bots.byId("main");
      await state.setInstructions("Draft replies in Matt's voice. Mail matt@example.com.");
      const answer = (await rpc(
        h.url,
        "/computer.v1.Seat/ExportBotTemplate",
        { generic: true, id: "main" },
        seat,
      )) as { generic: boolean; note: string; template: { instructions: string } };
      expect(answer.generic).toBe(false);
      expect(answer.note).toContain("no model");
      // The half that is still true happened: the address is gone.
      expect(answer.template.instructions).toBe("Draft replies in Matt's voice. Mail [removed].");
    } finally {
      await h.close();
    }
  });

  it("never hands back the verbatim document under a generic flag", async () => {
    const h = await startHub({
      // A gateway that is not there: the rewrite throws, and the reply has to
      // own that rather than quietly answering with the Bot as it is.
      templateGeneric: { ...CFG, endpoint: "http://127.0.0.1:1/v1/chat/completions" },
    });
    try {
      const seat = await h.pair();
      const { state } = h.hub.bots.byId("main");
      await state.setInstructions("Ping matt@example.com when the deploy lands.");
      const answer = (await rpc(
        h.url,
        "/computer.v1.Seat/ExportBotTemplate",
        { generic: true, id: "main" },
        seat,
      )) as { generic: boolean; note: string; template: { instructions: string } };
      expect(answer.generic).toBe(false);
      expect(answer.note).toContain("did not run");
      expect(answer.template.instructions).toBe("Ping [removed] when the deploy lands.");
    } finally {
      await h.close();
    }
  });

  it("exports the Bot as it is when nobody asked for generic", async () => {
    const h = await startHub();
    try {
      const seat = await h.pair();
      const { state } = h.hub.bots.byId("main");
      await state.setInstructions("Mail matt@example.com.");
      const answer = (await rpc(
        h.url,
        "/computer.v1.Seat/ExportBotTemplate",
        { id: "main" },
        seat,
      )) as { generic: boolean; note: string; template: { instructions: string } };
      expect(answer).toMatchObject({ generic: false, note: "" });
      // Verbatim means verbatim: a backup of your own Bot is not a leak.
      expect(answer.template.instructions).toBe("Mail matt@example.com.");
    } finally {
      await h.close();
    }
  });
});
