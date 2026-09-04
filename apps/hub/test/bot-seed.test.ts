import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AVATAR_COLORS, AVATAR_SHAPES, BOT_PROFILE_MAX } from "@computer/shared";
import type { BotProfile } from "@computer/shared";
import { describe, expect, it } from "vitest";
import { FakeDesk } from "../src/desk/fake.ts";
import { profileSeeds } from "../src/host/bot-seed.ts";
import { BotState } from "../src/service/state.ts";

const BOTS_ROOT = resolve(import.meta.dirname, "../../eve/bots");

/** The reader, with the filesystem faked, so the rules are testable in isolation. */
function reader(files: Record<string, string>) {
  return profileSeeds("/bots", (path) => {
    const found = files[path];
    if (found === undefined) {
      throw new Error(`ENOENT ${path}`);
    }
    return found;
  });
}

describe("a Bot ships with a profile", () => {
  it("reads agent/profile.json from the Bot's own project", () => {
    const seed = reader({
      "/bots/qa/agent/profile.json": JSON.stringify({ name: "QA", title: "Bug fixer" }),
    })("qa");
    expect(seed).toEqual({ name: "QA", title: "Bug fixer" });
  });

  it("reads a standalone project's profile as main's", () => {
    const seed = reader({ "/bots/agent/profile.json": JSON.stringify({ name: "Vibey" }) })("main");
    expect(seed).toEqual({ name: "Vibey" });
  });

  it("is nothing when the file is missing, empty, or not an object", () => {
    expect(reader({})("qa")).toBeUndefined();
    expect(reader({ "/bots/qa/agent/profile.json": "not json" })("qa")).toBeUndefined();
    expect(reader({ "/bots/qa/agent/profile.json": "[]" })("qa")).toBeUndefined();
  });

  it("seeds an empty profile once and never over one the box has", async () => {
    const desk = new FakeDesk();
    const state = new BotState(desk, "qa");
    await state.init({
      avatar_color: "#ff6700",
      avatar_shape: "wedge",
      description: "Owns incidents.",
      name: "QA",
      title: "QA and bug fixer",
    });
    expect(await state.profile()).toEqual({
      avatar_color: "#ff6700",
      avatar_shape: "wedge",
      description: "Owns incidents.",
      id: "qa",
      name: "QA",
      title: "QA and bug fixer",
    });

    // A rename by the human (or by the Bot itself) survives the next boot.
    await state.setProfile({
      avatar_color: "#0091ff",
      avatar_shape: "circle",
      description: "",
      name: "Quality",
      title: "",
    });
    await state.init({ avatar_color: "#ff6700", avatar_shape: "wedge", name: "QA" });
    const kept = await state.profile();
    expect(kept.name).toBe("Quality");
  });

  it("falls back to the hashed default for a field the seed gets wrong", async () => {
    const state = new BotState(new FakeDesk(), "pm");
    await state.init({
      avatar_color: "rebeccapurple" as BotProfile["avatar_color"],
      avatar_shape: "trapezoid" as BotProfile["avatar_shape"],
      name: "PM",
    });
    const profile = await state.profile();
    expect(profile.name).toBe("PM");
    expect(AVATAR_COLORS).toContain(profile.avatar_color);
    expect(AVATAR_SHAPES).toContain(profile.avatar_shape);
  });
});

/**
 * The shipped profiles are data in git that reaches a client as an inline
 * style and a Bot as its own prompt. A typo in one degrades silently at
 * runtime (the hashed default, in the wrong colour), so it is caught here.
 */
describe("the profiles this build ships", () => {
  // `template` is the project a Bot made from `Seat.CreateBot` runs, not a
  // Bot: it has no roster row, so a shipped profile for it is one nothing
  // would ever read. The assertion below is that it stays that way.
  const ids = readdirSync(BOTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "template")
    .map((e) => e.name);

  it("ships no profile for the template, which is not a Bot", () => {
    expect(existsSync(join(BOTS_ROOT, "template", "agent", "profile.json"))).toBe(false);
  });

  it("covers every Bot in the tree", () => {
    expect(ids.length).toBeGreaterThan(1);
  });

  it.each(ids)("%s has a valid mark and fits the caps", (id) => {
    const raw = readFileSync(join(BOTS_ROOT, id, "agent", "profile.json"), "utf-8");
    const profile = JSON.parse(raw) as BotProfile;
    expect(AVATAR_SHAPES).toContain(profile.avatar_shape);
    expect(AVATAR_COLORS).toContain(profile.avatar_color);
    expect(profile.name.length).toBeGreaterThan(0);
    expect(profile.name.length).toBeLessThanOrEqual(BOT_PROFILE_MAX.name);
    expect(profile.title.length).toBeLessThanOrEqual(BOT_PROFILE_MAX.title);
    expect(profile.description.length).toBeLessThanOrEqual(BOT_PROFILE_MAX.description);
  });
});
