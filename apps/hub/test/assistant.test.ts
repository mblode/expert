import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantState } from "../src/service/assistant.ts";
import { rpc, startHub } from "./helper.ts";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true });
});
describe("approved runtime configuration", () => {
  it("persists revisions, refuses stale edits and undoes without rewriting history", () => {
    const directory = mkdtempSync(join(tmpdir(), "assistant-"));
    directories.push(directory);
    const path = join(directory, "revisions.json");
    const state = new AssistantState(path);
    const memory = ["Keep replies short"];
    state.edit("main", { operation: "replace", base_revision: 0, memory }, "owner");
    memory[0] = "changed after save";
    expect(state.read("main").memory).toEqual(["Keep replies short"]);
    const recovered = new AssistantState(path);
    expect(() =>
      recovered.edit("main", { operation: "replace", base_revision: 0, memory: [] }, "owner"),
    ).toThrow("configuration changed");
    expect(recovered.edit("main", { operation: "undo", base_revision: 1 }, "owner")).toMatchObject({
      revision: 2,
      memory_set: false,
      memory: [],
    });
    expect(new AssistantState(path).read("main").revision).toBe(2);
    expect(recovered.read("other").revision).toBe(0);
  });
  it("refuses permission fields, empty changes and duplicate procedures", () => {
    const state = new AssistantState();
    for (const fields of [{}, { permissions: ["all"] }, { skills: [1] }, { memory: [""] }]) {
      expect(() =>
        state.edit("main", { operation: "replace", base_revision: 0, ...fields }, "owner"),
      ).toThrow();
    }
    const skill = { id: "review", description: "Review changes", markdown: "Read the diff" };
    expect(() =>
      state.edit(
        "main",
        { operation: "replace", base_revision: 0, skills: [skill, skill] },
        "owner",
      ),
    ).toThrow("invalid skill");
    expect(
      state.edit("main", { operation: "replace", base_revision: 0, skills: [skill] }, "owner")
        .revision,
    ).toBe(1);
  });
  it("allows an owner seat but refuses a bot and a narrower seat", async () => {
    const h = await startHub();
    try {
      const path = "/computer.v1.Seat/ConfigureAssistant";
      const request = {
        id: "main",
        configuration: { operation: "replace", base_revision: 0, instructions: "Be brief" },
      };
      await expect(rpc(h.url, path, request, h.agent)).rejects.toThrow();
      const owner = await h.pair();
      const issued = (await rpc(
        h.url,
        "/computer.v1.Seat/Issue",
        { role: "operator", subject: "guest" },
        owner,
      )) as { token: string };
      await expect(rpc(h.url, path, request, issued.token)).rejects.toThrow();
      expect(await rpc(h.url, path, request, owner)).toMatchObject({
        revision: 1,
        instructions: "Be brief",
      });
      expect(await rpc(h.url, "/computer.v1.Agent/Spec", {}, h.agent)).toMatchObject({
        runtime: { revision: 1, instructions: "Be brief" },
      });
    } finally {
      await h.close();
    }
  });
});
