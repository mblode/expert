import { describe, expect, it } from "vitest";

import {
  countInstall,
  createTemplate,
  deleteTemplate,
  listTemplates,
  publishedTemplate,
  replaceTemplate,
  setPublished,
  templateById,
} from "./bot-template-store";

/**
 * The link's whole life, against the in-memory database `lib/db` falls back to
 * outside production. What is being pinned is who may see what: a draft is
 * invisible to everyone but its owner, publishing is what makes the link
 * resolve, and deleting turns it off again.
 */
const DOC = {
  avatar_color: "#0091ff",
  avatar_shape: "diamond",
  description: "Front of house.",
  instructions: "Route work to the specialist.",
  memories: [],
  name: "Chief of Staff",
  plugins: [],
  routines: [],
  skills: [],
  title: "personal ops",
  version: 1,
};

async function draftFor(ownerId: string): Promise<string> {
  const created = await createTemplate({
    botId: "cos",
    computerId: "vibey",
    ownerId,
    template: DOC,
  });
  if ("error" in created) {
    throw new Error(created.error);
  }
  return created.id;
}

describe("a shared template's link", () => {
  it("is a draft until it is published, and resolves only then", async () => {
    const id = await draftFor("owner-1");
    // The row exists and its owner can read it: this is the preview.
    expect(await templateById(id)).toMatchObject({ ownerId: "owner-1" });
    // To anyone with the link, an unpublished template is simply not there.
    expect(await publishedTemplate(id)).toBeUndefined();

    const published = await setPublished(id, "owner-1", true);
    expect(published).not.toHaveProperty("error");
    expect(await publishedTemplate(id)).toMatchObject({ id });

    // Unpublishing keeps the row and the id: the same link comes back.
    await setPublished(id, "owner-1", false);
    expect(await publishedTemplate(id)).toBeUndefined();
    expect(await templateById(id)).toMatchObject({ id });
  });

  it("belongs to one account: nobody else may publish, replace or delete it", async () => {
    const id = await draftFor("owner-2");
    expect(await setPublished(id, "someone-else", true)).toMatchObject({ status: 403 });
    expect(await replaceTemplate(id, "someone-else", DOC)).toMatchObject({ status: 403 });
    expect(await deleteTemplate(id, "someone-else")).toMatchObject({ status: 404 });
    // And none of the three did anything on the way to saying no.
    expect(await templateById(id)).toMatchObject({ ownerId: "owner-2" });
  });

  it("improves at the link people already have", async () => {
    const id = await draftFor("owner-3");
    await setPublished(id, "owner-3", true);
    const updated = await replaceTemplate(id, "owner-3", {
      ...DOC,
      description: "Now with routines.",
    });
    expect(updated).toMatchObject({ id });
    const live = await publishedTemplate(id);
    expect(live?.template.description).toBe("Now with routines.");
    // Publishing survives an edit: the link does not go dark because the Bot
    // was improved.
    expect(live?.publishedAt).toBeDefined();
  });

  it("counts the Bots made from it", async () => {
    const id = await draftFor("owner-4");
    await setPublished(id, "owner-4", true);
    await countInstall(id);
    await countInstall(id);
    const record = await templateById(id);
    expect(record?.installs).toBe(2);
  });

  it("is gone when it is deleted, which is what turns the link off", async () => {
    const id = await draftFor("owner-5");
    await setPublished(id, "owner-5", true);
    expect(await deleteTemplate(id, "owner-5")).toEqual({ deleted: true });
    expect(await templateById(id)).toBeUndefined();
    expect(await publishedTemplate(id)).toBeUndefined();
    expect(await deleteTemplate(id, "owner-5")).toMatchObject({ status: 404 });
  });

  it("lists an account's own templates and nobody else's", async () => {
    const mine = await draftFor("owner-6");
    await draftFor("owner-7");
    const rows = await listTemplates("owner-6");
    expect(rows.map((row) => row.id)).toEqual([mine]);
    expect(rows[0]?.botId).toBe("cos");
  });

  it("refuses a document that is not a template", async () => {
    expect(
      await createTemplate({
        botId: "cos",
        computerId: "vibey",
        ownerId: "owner-8",
        template: { name: "   " },
      }),
    ).toMatchObject({ status: 400 });
  });
});
