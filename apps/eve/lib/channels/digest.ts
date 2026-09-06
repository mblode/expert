import { defineChannel, GET } from "eve/channels";

import { bridgeConfigured, bridgePost } from "../vibey/bridge-client.ts";
import { outboundReply } from "../format-reply.ts";
import { recordEpisode } from "../vibey/memory-store.ts";

/**
 * Digest delivery channel.
 *
 * A schedule can't post anywhere on its own, so `agent/schedules/daily-digest.ts`
 * hands the recap prompt here via `to(digest, target).send(...)`, which eve
 * routes into this channel's `receive` hook. This channel runs the agent to
 * produce the digest, then, the eve-idiomatic "the channel owns delivery",
 * pushes the finished text to the Baileys bridge's `POST /send`, which delivers
 * it to the recipient. The bridge allowlists that endpoint, so the target must
 * be an owner/maintainer/digest-recipient DM or a group in `DIGEST_GROUP_JID`.
 *
 * It has no real HTTP routes: nothing inbound reaches it, it's a proactive-only
 * outbound surface driven entirely by the cron handoff.
 */

interface DigestState {
  /** Where the finished digest gets sent, carried from the handoff `target`. */
  recipientJid: string | null;
  /** Dedup key for the send, carried from the handoff `target`. */
  idempotencyKey: string | null;
  /** The latest completed assistant text; the last one wins at turn end. */
  latest: string | null;
  /** Local day of the recap, used to file it as that day's episode. */
  day: string | null;
  /** Which prompt produced it. */
  style: string | null;
  /** How many messages it summarised. */
  messageCount: number;
}

interface DigestTarget {
  recipientJid: string;
  idempotencyKey: string;
  day: string;
  style: string;
  messageCount: number;
}

const emptyState = (recipientJid: string | null, target?: Partial<DigestTarget>): DigestState => ({
  day: target?.day ?? null,
  idempotencyKey: target?.idempotencyKey ?? null,
  latest: null,
  messageCount: target?.messageCount ?? 0,
  recipientJid,
  style: target?.style ?? null,
});

export default defineChannel<DigestState, { state: DigestState }, DigestTarget>({
  context(state) {
    return { state };
  },
  events: {
    // The agent may emit interim narration before any tool call; keep only the
    // last completed message, mirroring the whatsapp channel's drainStream.
    "message.completed"(data, channel) {
      if (typeof data.message === "string" && data.message.trim()) {
        channel.state.latest = data.message;
      }
    },
    // Turn's done: deliver the digest. Best-effort — a failed push shouldn't
    // throw out of the cron task.
    async "turn.completed"(_data, channel) {
      const jid = channel.state.recipientJid;
      const text = channel.state.latest;
      console.info(
        `[digest-channel] turn.completed jid=${jid} textLen=${text?.length ?? 0} bridge=${bridgeConfigured()}`,
      );
      if (!jid || !text?.trim() || !bridgeConfigured()) {
        return;
      }
      try {
        await bridgePost("/send", {
          idempotencyKey: channel.state.idempotencyKey ?? undefined,
          jid,
          text: outboundReply(text),
        });
        console.info(`[digest-channel] sent ${jid}`);
      } catch (error) {
        // Best-effort: the next morning's digest tries again.
        console.error(`[digest-channel] send failed ${jid}: ${String(error)}`);
      }

      // Keep the recap. Separate try/catch and after the send: the digest
      // landing in someone's DM is the job, and failing to file it must never
      // cost them the message. One canonical episode per day, so whichever
      // subscriber's morning comes first sets the record.
      const sourceGroup = process.env.REFRESH_GROUP_JID?.trim();
      const { day, style, messageCount } = channel.state;
      if (!(sourceGroup && day)) {
        // Never silent again. This guard swallowed every recap for five days
        // because a resumed session carried state without a `day`, and a
        // skipped episode looks exactly like a group that had nothing on.
        console.error(
          `[digest-channel] episode skipped: sourceGroup=${Boolean(sourceGroup)} day=${day ?? "unset"}`,
        );
        return;
      }
      try {
        await recordEpisode(sourceGroup, {
          day,
          messageCount,
          style: style ?? "digest",
          t: Math.floor(Date.now() / 1000),
          text: outboundReply(text),
        });
      } catch (error) {
        console.error(`[digest-channel] episode failed: ${String(error)}`);
      }
    },
  },
  receive(input, { from }) {
    // One session per recipient PER DAY. The day is load-bearing, not cosmetic:
    // `send`'s `state` is the *initial* state and is only applied when the
    // address has no live session. eve 0.49 words it as "only `send()` can
    // create a session when the address is unowned"; an owned address resumes
    // the owner, so a resumed session silently keeps whatever state the first
    // run left behind.
    //
    // With a day-free token every recipient had exactly one session, created
    // the first morning they subscribed, and every morning after that ran with
    // that first run's state. The digest sessions predate `recordEpisode`
    // (shipped 2026-08-05), so their stored state had no `day` field at all
    // and `turn.completed`'s `if (sourceGroup && day)` was false every single
    // night: the DM went out, the recap was thrown away, and nothing logged.
    // `idempotencyKey` and `style` were stale the same way.
    //
    // A replay on the same day still resumes the same session, which is what
    // the bridge's idempotency key is for.
    //
    // The address is channel-local (eve prefixes the channel name itself), so
    // this is the same token the pre-0.49 `continuationToken` option carried.
    return from(`digest#${input.target.recipientJid}#${input.target.day}`).send(input.message, {
      auth: input.auth,
      state: emptyState(input.target.recipientJid, input.target),
    });
  },
  // The schedule hands off here via `to()`. eve resolves that target by
  // module reference, then falls back to matching on the channel's route
  // fingerprint (still true in 0.49, see `resolveTargetByReference`), and a
  // channel with no routes has no fingerprint, so the handoff throws "not
  // registered". This one inert route gives the channel a stable fingerprint
  // so the fallback resolves it. It's not a real endpoint.
  routes: [GET("/eve/v1/digest/status", () => Promise.resolve(Response.json({ ok: true })))],
  state: emptyState(null),
  // 0.49 defaults a channel to "steer", which cancels a running turn when a
  // second send lands on the same address. The token is per recipient per
  // day, so a replayed handoff while the first recap is still generating
  // would restart it; queue behind it instead and let the bridge's
  // idempotency key collapse the duplicate delivery.
  turnPolicy: "queue",
});
