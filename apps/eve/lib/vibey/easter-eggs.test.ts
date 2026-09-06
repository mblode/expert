import { describe, it, expect } from "vitest";

import eggsSkill from "../skills/easter-eggs.ts";

import { EASTER_EGGS, EASTER_EGG_COMMANDS } from "./easter-eggs.js";

/** Bits the group stopped telling. Retired Aug 2026, must not come back. */
const RETIRED = ["/factorio", "/nobodyknows", "/wearesoback"];

describe("EASTER_EGGS catalogue", () => {
  it.each(EASTER_EGG_COMMANDS)("documents the %s command", (cmd) => {
    expect(EASTER_EGGS).toContain(`\`${cmd}\``);
  });

  it.each(RETIRED)("no longer documents the retired %s command", (cmd) => {
    expect(EASTER_EGGS).not.toContain(cmd);
  });
});

describe("EASTER_EGGS respects WhatsApp constraints", () => {
  // The section feeds straight into the system prompt and the example lines are
  // tone anchors, so the copy itself must already pass the cleanReply rules.
  it("uses no Markdown ** double-asterisk bold", () => {
    expect(EASTER_EGGS).not.toMatch(/\*\*/u);
  });

  it("uses no em or en dashes", () => {
    expect(EASTER_EGGS).not.toMatch(/[—–]/u);
  });
});

describe("the skill description stays in sync with the catalogue", () => {
  // eve advertises this description every turn and the model routes off it, so
  // a trigger missing here is a bit that never fires however good the catalogue
  // copy is. Checked both ways: `scripts/smoke.ts` spent months sweeping
  // commands (`/erlich`, `/gilfoyle`, `/firsttaste`) that had been deleted,
  // which is the same drift in the other direction.
  const { description } = eggsSkill;

  it.each(EASTER_EGG_COMMANDS)("advertises %s", (cmd) => {
    expect(description).toContain(cmd);
  });

  it("advertises no command the catalogue doesn't document", () => {
    // `/help` is the documented alias for `/eggs`, not a tenth egg.
    const known = new Set<string>([...EASTER_EGG_COMMANDS, "/help"]);
    // Only a slash that starts a word is a command; the lookbehind keeps prose
    // like "persona/joke brief" out of the match.
    const advertised = description?.match(/(?<=^|[\s'"])\/[a-z]+/gu) ?? [];
    expect(advertised.filter((cmd) => !known.has(cmd))).toStrictEqual([]);
  });
});
