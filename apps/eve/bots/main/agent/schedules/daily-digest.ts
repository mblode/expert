import { defineSchedule } from "eve/schedules";

import {
  buildDigestHandoff,
  dueSubscribers,
  parseSubscribers,
} from "../../../../lib/vibey/daily-digest.ts";

import digest from "../../../../lib/channels/digest.ts";

/**
 * Morning digest — a private DM recapping the VCMC group's overnight activity,
 * driven by a member's ask ("every morning, a review of everything I missed").
 *
 * Recipients are per-user (`DIGEST_SUBSCRIBERS`), each with their own timezone
 * and local send hour. Vercel evaluates cron in UTC and can't track DST or run a
 * schedule per user, so this one fires hourly and `dueSubscribers` selects
 * whoever's local hour matches this tick (usually nobody, sometimes one or two);
 * `Intl` resolves each timezone's current offset, so DST is automatic. Each due
 * subscriber gets one session and one send — no fan-out to the whole list.
 *
 * Handler form (not `markdown`): the recap is assembled deterministically and
 * delivery hops through the digest channel, neither of which fits a
 * fire-and-forget prompt.
 */
export default defineSchedule({
  cron: "0 * * * *",
  async run({ to, waitUntil, appAuth }) {
    const subs = parseSubscribers();
    const due = dueSubscribers(subs, new Date());
    // Structured trace so a schedule run is observable in Vercel logs (a cron
    // that no-ops looks identical to one that never fired otherwise).
    console.info(
      `[daily-digest] tick subscribers=${subs.length} due=${due.length}`,
      due.map((s) => s.jid),
    );
    if (due.length === 0) {
      return;
    }
    const work = Promise.all(
      due.map(async (subscriber) => {
        const handoff = await buildDigestHandoff(subscriber);
        console.info(
          `[daily-digest] handoff ${subscriber.jid}=${handoff ? `${handoff.messageCount}msgs` : "null"}`,
        );
        if (!handoff) {
          return;
        }
        // eve 0.49 replaced the schedule's `receive(channel, { message, target,
        // auth })` with `to(channel, target).send(message, { auth })`. Same hop:
        // the digest channel's `receive` hook still owns the token and state.
        await to(digest, {
          day: handoff.day,
          idempotencyKey: handoff.idempotencyKey,
          messageCount: handoff.messageCount,
          recipientJid: handoff.recipientJid,
          style: handoff.style,
        }).send(handoff.prompt, { auth: appAuth });
        console.info(`[daily-digest] handed off ${subscriber.jid}`);
      }),
    );
    // Await inline (not just waitUntil) so the send completes within the cron
    // invocation — background waitUntil work can be frozen once the handler
    // returns. waitUntil is kept as belt-and-suspenders for the runtime.
    waitUntil(work);
    await work;
  },
});
