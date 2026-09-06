import { defineSchedule } from "eve/schedules";

import { alertMaintainer } from "../../../../lib/vibey/alert.ts";
import { consolidationHour, runConsolidation } from "../../../../lib/vibey/consolidation-run.ts";

/**
 * The overnight memory pass.
 *
 * Fires hourly and no-ops unless the UTC hour matches, exactly like
 * `daily-digest`. Vercel Cron evaluates expressions in UTC and eve schedules are
 * static build-time files, so "3am Melbourne" can't be expressed directly — an
 * hourly tick plus an hour check is the same trick the digest already relies on.
 *
 * Daily rather than per-turn: VCMC runs ~24 messages a day, so a per-message
 * pass would be 24 extraction runs over a one-message delta, and a fact usually
 * spans several messages anyway.
 *
 * A healthy night is silent. On failure it DMs the maintainer and logs at error
 * level under a `[memory-consolidation]` prefix, which is what Vercel's runtime
 * logs and the Agent Runs view surface.
 *
 * Known limit, accepted deliberately: neither signal can report a run that
 * never fires. Vercel cron delivery is best effort, and a skipped invocation
 * produces no log at all — so an absent run is indistinguishable from a quiet
 * one. Catching that needs something outside Vercel holding a timer, which we
 * have chosen not to run.
 */
export default defineSchedule({
  cron: "0 * * * *",
  async run({ waitUntil }) {
    const now = new Date();
    if (now.getUTCHours() !== consolidationHour()) {
      return;
    }

    const groupJid = process.env.REFRESH_GROUP_JID?.trim();
    if (!groupJid) {
      console.warn("[memory-consolidation] no REFRESH_GROUP_JID, skipping");
      // Named rather than silent. Without the JID the pass never runs at all,
      // so no other tripwire can fire and nothing else would report it.
      await alertMaintainer({
        dedupeKey: `memfail#nojid#${now.toISOString().slice(0, 10)}`,
        headline: "@vibey memory pass didn't run: REFRESH_GROUP_JID isn't set.",
      });
      return;
    }

    // One key per day per failure kind, so a replayed cron invocation collapses
    // onto the original instead of texting twice. Vercel is explicit that a
    // scheduled run can be delivered more than once.
    const day = now.toISOString().slice(0, 10);
    const work = (async () => {
      try {
        const result = await runConsolidation({ groupJid, now });
        console.info(
          `[memory-consolidation] ran=${result.ran} applied=${result.applied} skipped=${result.plan?.skipped.length ?? 0}${result.reason ? ` reason=${result.reason}` : ""}`,
        );
        if (result.report) {
          // The runtime log is the record for a healthy night. Nothing is DMed:
          // every write is tagged, audited and revertable, and `memory-log`
          // answers on demand. Note Vercel Pro keeps runtime logs for 1 day,
          // so this is a short window — Observability Plus extends it to 30.
          console.info(`[memory-consolidation] report\n${result.report}`);
        }

        const violations = result.tripwires?.violations ?? [];
        if (!result.ran) {
          // Bridge or Blob unconfigured. In production both always are, so this
          // means the pass has quietly been doing nothing — and because it
          // never reaches the write, no tripwire can report it either.
          console.error(`[memory-consolidation] did not run: ${result.reason ?? "unknown"}`);
          await alertMaintainer({
            dedupeKey: `memfail#notrun#${day}`,
            detail: result.reason,
            headline: "@vibey memory pass didn't run tonight.",
          });
        } else if (violations.length > 0) {
          // A broken invariant is worth the same page as a crash: the run
          // "succeeded", which is precisely why nothing else would notice.
          const detail = violations.map((v) => `  - ${v}`).join("\n");
          console.error(`[memory-consolidation] TRIPWIRE\n${detail}`);
          await alertMaintainer({
            dedupeKey: `memfail#tripwire#${day}`,
            detail,
            headline: `@vibey memory pass tripped ${violations.length} invariant${violations.length === 1 ? "" : "s"}. It wrote anyway — undo with: @vibey memory-log, then revert memory <id>`,
          });
        }
      } catch (error) {
        // Logged and swallowed: one bad night shouldn't mark the cron itself
        // unhealthy. The swallow does mean Vercel records a 200, so its own
        // error-rate signals never fire for this — the DM below is the alert,
        // and this line is the record in the runtime log and Agent Runs.
        console.error("[memory-consolidation] failed", error);
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        await alertMaintainer({
          dedupeKey: `memfail#error#${day}`,
          detail: message,
          headline: "@vibey memory pass failed tonight.",
        });
      }
    })();

    // Await inline, not just waitUntil: background work is silently frozen once
    // the cron handler returns, which is how the digest lost sends before this
    // was understood. waitUntil stays as belt-and-braces for the runtime.
    waitUntil(work);
    await work;
  },
});
