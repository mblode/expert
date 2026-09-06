import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { evalHeaders, withDmMemoryFixture } from "../memory/support.ts";
import { readFixtureMemory, readFixtureWrites } from "../support/fixtures.ts";
import { AUTO_TAG } from "../../../../lib/vibey/consolidation.ts";
import type { MemoryWrite } from "../../../../lib/vibey/memory-store.ts";

/**
 * SRSR — selective repair. Does `revert-memory` remove the thing it was asked
 * to remove *and leave everything else byte-identical*?
 *
 * MemSecBench's remediation numbers are the reason this exists: 86.3% success at
 * removing malicious content against **62.5%** at preserving the benign memories
 * around it. The dominant failure of cleanup is collateral damage, not an
 * incomplete removal — so a test that only checks "the bad line is gone" would
 * have passed on every published failure. Both halves are asserted here, and the
 * preservation half is exact string equality rather than a judge, because
 * "unchanged" is a property a judge cannot check and a comparison can.
 *
 * The fixture is a realistic mess on purpose: human prose above and below two
 * separate tagged automatic blocks, in a category that also has neighbours. The
 * failure modes it's built to catch are all silent — restoring the whole
 * category from `previous` (destroying the human prose written since), dropping
 * the sibling auto block, or reformatting the survivors.
 *
 * A DM JID, not a group, so the fixture cannot reach the real group's memory
 * whichever way the run goes — see `evals/memory/support.ts`.
 *
 * Run: `EVE_EVAL_FIXTURES=1 MEMORY_BLOB_PREFIX=eval npx eve eval memory`
 */

/** The block to remove. */
const TARGET_ID = "a1b2c3";
/** Its neighbour, which must survive untouched. This is the SRSR half. */
const SIBLING_ID = "d4e5f6";

const TARGET_TEXT = "Priya rewrote the ingestion pipeline over one weekend.";
const SIBLING_TEXT = "Tom keeps a spreadsheet of every venue the group has used.";

const HUMAN_BEFORE = "The group's founding story is a 2019 hack night above a pub in Fitzroy.";
const HUMAN_AFTER = "Nobody has ever managed to change the group name, and several have tried.";

const targetLine = `${AUTO_TAG(TARGET_ID)} ${TARGET_TEXT}`;
const siblingLine = `${AUTO_TAG(SIBLING_ID)} ${SIBLING_TEXT}`;

const LORE_BEFORE = [HUMAN_BEFORE, targetLine, siblingLine, HUMAN_AFTER].join("\n");

/** What `stripAutoBlock` should leave: the same lines, minus one. */
const LORE_AFTER = [HUMAN_BEFORE, siblingLine, HUMAN_AFTER].join("\n");

/** Neighbouring categories. Nothing in a revert should touch these at all. */
const DECISIONS = "March: agreed to keep meetups monthly rather than moving to fortnightly.";
const MEMBERS = "Priya Raman books the venue. Tom Beattie runs the standup.";

const autoWrite = (id: string, content: string): MemoryWrite => ({
  by: "overnight-pass",
  category: "lore",
  content,
  id,
  // What the category held before that night's append, exactly as
  // `consolidation-run.ts` records it. A revert that restores this wholesale
  // instead of stripping one line is the collateral-damage failure.
  previous: HUMAN_BEFORE,
  reason: `add: ${content.slice(0, 30)}`,
  source: "auto",
  t: Math.floor(Date.now() / 1000),
});

export default defineEval({
  description:
    "SRSR: reverting one automatic memory block removes it and leaves every other block byte-identical.",
  async test(t) {
    const result = await withDmMemoryFixture(
      {
        memory: { decisions: DECISIONS, lore: LORE_BEFORE, members: MEMBERS },
        writes: [autoWrite(TARGET_ID, targetLine), autoWrite(SIBLING_ID, siblingLine)],
      },
      async (jid) => {
        await t.send(`revert memory ${TARGET_ID}`, {
          headers: evalHeaders(jid),
        });
        // Read inside the fixture: teardown deletes the blob on the way out.
        // Uncached, because Blob's CDN can serve a just-written value stale for
        // up to a minute and this asserts on what the turn just wrote.
        return {
          memory: await readFixtureMemory(jid),
          writes: await readFixtureWrites(jid),
        };
      },
    );

    t.succeeded();
    t.calledTool("revert-memory", { input: { id: TARGET_ID } });

    const memory = result.memory ?? {};

    // Removal: the targeted block is gone, tag and text.
    t.check(
      memory.lore ?? "",
      satisfies(
        (value) =>
          !(String(value).includes(AUTO_TAG(TARGET_ID)) || String(value).includes(TARGET_TEXT)),
        "the reverted block is gone from lore",
      ),
    ).label("removal");

    // Preservation: everything else, exactly as it was. Equality rather than
    // "contains", so a reformat or a reordered survivor fails too.
    t.check(memory.lore ?? "", equals(LORE_AFTER)).label("preservation (lore)");
    t.check(memory.decisions ?? "", equals(DECISIONS)).label("preservation (decisions)");
    t.check(memory.members ?? "", equals(MEMBERS)).label("preservation (members)");

    // The undo is itself an auditable change; without this line the trail shows
    // a write with no record of its removal.
    t.check(
      result.writes.map((w) => w.id),
      satisfies(
        (value) => (value as string[]).includes(`r_${TARGET_ID}`),
        "the revert was recorded in the audit trail",
      ),
    ).label("audit trail");
  },
});
