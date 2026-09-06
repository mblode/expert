import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IDENTITY_FILE, resetIdentityCache, tenantIdentity } from "../instructions/identity.ts";
import {
  parseSkillFile,
  readTenantSkill,
  resetTenantSkillCache,
  SKILLS_DIR,
} from "./tenant-skill.ts";

const FOLDED = `---
description: >-
  Use when a message leans on the group's shared language and you need
  the reference to riff on it.
---

# Group lore

Shared language you can riff on.
`;

describe("tenant identity and skills on the volume", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vibey-tenant-skills-"));
    process.env.COMPUTER_BOT_DATA = dir;
    resetIdentityCache();
    resetTenantSkillCache();
  });

  afterEach(() => {
    delete process.env.COMPUTER_BOT_DATA;
    resetIdentityCache();
    resetTenantSkillCache();
    rmSync(dir, { force: true, recursive: true });
  });

  it("contributes nothing on a computer with no identity or skill files", () => {
    expect(tenantIdentity()).toBeNull();
    expect(readTenantSkill("group-lore")).toBeNull();
  });

  it("reads the identity file once it exists", () => {
    writeFileSync(join(dir, IDENTITY_FILE), "# Identity\n\nYou are **@Vibey**.\n");
    resetIdentityCache();
    expect(tenantIdentity()).toContain("You are **@Vibey**");
  });

  it("reads a skill's folded description and its body", () => {
    mkdirSync(join(dir, SKILLS_DIR));
    writeFileSync(join(dir, SKILLS_DIR, "group-lore.md"), FOLDED);
    const skill = readTenantSkill("group-lore");
    expect(skill?.description).toBe(
      "Use when a message leans on the group's shared language and you need the reference to riff on it.",
    );
    expect(skill?.markdown.startsWith("# Group lore")).toBe(true);
  });

  it("parses a plain description, and falls back to the first body line", () => {
    expect(parseSkillFile('---\ndescription: "Do the thing."\n---\nBody here.\n')).toEqual({
      description: "Do the thing.",
      markdown: "Body here.",
    });
    expect(parseSkillFile("# Heading first\n\nThen prose.\n")).toEqual({
      description: "Heading first",
      markdown: "# Heading first\n\nThen prose.",
    });
    expect(parseSkillFile("---\ndescription: x\n---\n\n")).toBeNull();
  });
});
