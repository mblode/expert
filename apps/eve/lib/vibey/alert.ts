import { bridgeConfigured, bridgePost } from "./bridge-client.ts";

/**
 * A WhatsApp DM to the maintainer when the overnight memory pass goes wrong.
 *
 * Deliberately failure-only. The nightly report is not sent — every write is
 * tagged, audited and revertable, and `memory-log` answers "what did you learn"
 * on demand — so a healthy night stays silent and a message means something
 * needs looking at.
 *
 * This is the alert. The runtime log is the record, but Vercel Pro keeps it for
 * a day and the schedule swallows its errors (so the cron reports 200 and
 * Vercel's own error-rate signals never fire) — which leaves the DM as the only
 * thing that reaches a human in time.
 *
 * It cannot report a run that never fired: only a run that happened can send a
 * message, and a skipped Vercel cron produces no log either. Delivery is
 * explicitly best effort, so an absent run is indistinguishable from a quiet
 * one. Catching that needs a timer outside Vercel, which we don't run.
 *
 * Best-effort throughout: a failed alert must never fail the run it is
 * reporting on, and must never mask the original error.
 */

/** Where alerts go. A DM — `POST /send` refuses group JIDs outright. */
const alertJid = (): string => process.env.MEMORY_ALERT_JID?.trim() || "61456455551@s.whatsapp.net";

/** WhatsApp is a chat window, not a log viewer. Keep it readable. */
const MAX_ALERT_CHARS = 1200;

const clip = (text: string): string =>
  text.length > MAX_ALERT_CHARS
    ? `${text.slice(0, MAX_ALERT_CHARS)}\n… (truncated, full detail in the logs)`
    : text;

/**
 * DM the maintainer that something went wrong.
 *
 * `dedupeKey` is passed to the bridge as an idempotency key so a replayed cron
 * invocation collapses onto the original instead of texting twice — Vercel is
 * explicit that cron delivery can fire the same scheduled run more than once.
 */
export const alertMaintainer = async ({
  headline,
  detail,
  dedupeKey,
}: {
  headline: string;
  detail?: string;
  dedupeKey: string;
}): Promise<boolean> => {
  if (!bridgeConfigured()) {
    return false;
  }
  const body = detail?.trim() ? `${headline}\n\n${clip(detail.trim())}` : headline;
  try {
    await bridgePost("/send", {
      idempotencyKey: dedupeKey,
      jid: alertJid(),
      text: body,
    });
    return true;
  } catch (error) {
    // Swallowed on purpose. The caller is already in a failure path; throwing
    // here would replace a useful error with a delivery error.
    console.error("[alert] could not deliver", error);
    return false;
  }
};
