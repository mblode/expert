import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MEMBERS_FILE,
  memberNames,
  memberProfiles,
  people,
  resetPeopleCache,
} from "./data/people.ts";
import { findInRoster, matchPerson, vcmcRoster } from "./roster.ts";

/**
 * The overlay is a file on the tenant's volume, so the tests write one. What
 * they pin is the derivation and the matching, not the VCMC data itself:
 * that file is checked where it is written (the seed script), not here.
 */

const OVERLAY = [
  {
    name: "Marcus Schappi",
    org: "Ninja.ai / Little Bird",
    phone: "+61400000001",
    role: "Founder",
    tags: ["mcp", "hardware"],
  },
  { aliases: ["Benji"], name: "Ben Simai", phone: "+61400000002", tags: [] },
  { name: "Ben", phone: "+61400000003", tags: [] },
  { name: "Luca Bonelli", phone: "+61400000004", tags: ["founder"] },
  { member: false, name: "Some Contact", phone: "+61400000005", tags: [] },
  // Rows the parser drops: no phone, no name, not an object.
  { name: "Ghost", tags: [] },
  { phone: "+61400000006" },
  "noise",
];

describe("the member overlay", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vibey-people-"));
    process.env.COMPUTER_BOT_DATA = dir;
    resetPeopleCache();
  });

  afterEach(() => {
    delete process.env.COMPUTER_BOT_DATA;
    resetPeopleCache();
    rmSync(dir, { force: true, recursive: true });
  });

  it("is empty on a computer with no file, and on a malformed one", () => {
    expect(people()).toEqual([]);
    expect(vcmcRoster()).toEqual([]);
    resetPeopleCache();
    writeFileSync(join(dir, MEMBERS_FILE), "{not json");
    expect(people()).toEqual([]);
  });

  describe("with a file", () => {
    beforeEach(() => {
      writeFileSync(join(dir, MEMBERS_FILE), JSON.stringify(OVERLAY));
    });

    it("keeps only rows with a phone and a name", () => {
      expect(people().map((p) => p.name)).toEqual([
        "Marcus Schappi",
        "Ben Simai",
        "Ben",
        "Luca Bonelli",
        "Some Contact",
      ]);
    });

    it("derives the roster from members only, carrying role, org and tags", () => {
      expect(vcmcRoster().map((e) => e.name)).toStrictEqual(memberProfiles().map((p) => p.name));
      expect(memberNames()).not.toContain("Some Contact");
      const marcus = vcmcRoster().find((e) => e.name === "Marcus Schappi");
      expect(marcus?.tags).toContain("mcp");
      expect(marcus?.org).toBe("Ninja.ai / Little Bird");
    });

    it("matches a full name, a first name, an alias, case-insensitively", () => {
      expect(findInRoster("Marcus Schappi")?.name).toBe("Marcus Schappi");
      expect(findInRoster("marcus")?.name).toBe("Marcus Schappi");
      expect(findInRoster("Benji")?.name).toBe("Ben Simai");
      expect(findInRoster("LUCA BONELLI")?.name).toBe("Luca Bonelli");
    });

    it("lets an exact alias beat a bare first name that would shadow it", () => {
      expect(matchPerson(people(), "Benji")?.name).toBe("Ben Simai");
      expect(matchPerson(people(), "Ben")?.name).toBe("Ben");
    });

    it("matches a 3+ char substring but ignores 2-char noise and empty input", () => {
      expect(findInRoster("schapp")?.name).toBe("Marcus Schappi");
      expect(findInRoster("be")).toBeUndefined();
      expect(findInRoster("")).toBeUndefined();
      expect(findInRoster()).toBeUndefined();
      expect(findInRoster("Some Randomperson")).toBeUndefined();
    });
  });
});
