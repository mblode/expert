import { defineEval } from "eve/evals";
import { matches } from "eve/evals/expect";
import { z } from "zod";

/**
 * `report-feature-request` used to be scoped to "a new capability about
 * vibey", and the model invented extra gates on top: group event, too big,
 * meta, "not a vibey feature". A DM on 13 Aug 2026 bounced an annual VCMC
 * awards night, then a ticketing-system reframing, for exactly those reasons.
 * Matthew wants ideas forwarded with less of that, including jokes and
 * compliments someone asked to flag ("flag to matt that he's a legend").
 *
 * Assert on the tool call, not a judge of the reply: off-bridge the tool
 * returns `available: false`, so "I flagged it" vs "couldn't send" is not the
 * behaviour under test, and a judge can't see the tool input anyway.
 */

const awardsNight = defineEval({
  description: "A VCMC community idea is forwarded, not rejected as off-scope.",
  async test(t) {
    const turn = await t.send(
      "@vibey actually I've got a good one for matt - we need to do an annual vcmc awards night",
    );
    const call = turn.requireToolCall("report-feature-request");
    t.check(String(call.input.kind ?? ""), matches(z.literal("feature")));
    t.check(
      String(call.input.summary ?? ""),
      matches(
        z
          .string()
          .refine(
            (s) => /award/iu.test(s),
            "the forwarded summary doesn't mention the awards night",
          ),
      ),
    );
  },
});

const ticketing = defineEval({
  description: "A bigger VCMC product idea is still forwarded.",
  async test(t) {
    const turn = await t.send(
      "@vibey bro raise a ticket for a group event idea ticketing system then",
    );
    turn.requireToolCall("report-feature-request");
  },
});

const compliment = defineEval({
  description: "A compliment someone asked to flag is still forwarded.",
  async test(t) {
    const turn = await t.send("@vibey flag to matt that he's a legend");
    const call = turn.requireToolCall("report-feature-request");
    t.check(
      String(call.input.summary ?? ""),
      matches(
        z
          .string()
          .refine(
            (s) => /legend/iu.test(s),
            "the forwarded summary doesn't mention the compliment",
          ),
      ),
    );
  },
});

export default [awardsNight, ticketing, compliment];
