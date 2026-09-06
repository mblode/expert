import { describe, expect, it } from "vitest";

import { normaliseEmail, requestAccess } from "./waitlist";
import type { ResendClient } from "./waitlist";
import { waitlistCount } from "./waitlist-store";

function outbox(): ResendClient & { sent: { to: string; subject: string }[]; contacts: string[] } {
  const sent: { to: string; subject: string }[] = [];
  const contacts: string[] = [];
  return {
    addContact: async (email) => {
      contacts.push(email);
    },
    contacts,
    send: async ({ to, subject }) => {
      sent.push({ subject, to });
    },
    sent,
  };
}

const notInvited = async () => false;

describe("the gate in front of sign-up", () => {
  it("normalises and refuses what is not an email", () => {
    expect(normaliseEmail("  Someone@Example.COM ")).toBe("someone@example.com");
    expect(normaliseEmail("nope")).toBeNull();
    expect(normaliseEmail(42)).toBeNull();
    expect(normaliseEmail(`${"a".repeat(250)}@x.co`)).toBeNull();
  });

  it("lets an allowed or invited address straight through, writing nothing", async () => {
    const before = await waitlistCount();
    const env = { AUTH_ALLOWED_EMAILS: "m@blode.co" };
    expect(
      await requestAccess(
        { email: "M@blode.co", source: "login" },
        { env, invited: notInvited, resend: null },
      ),
    ).toEqual({ status: "allowed" });
    expect(
      await requestAccess(
        { email: "guest@example.com", source: "login" },
        { env, invited: async () => true, resend: null },
      ),
    ).toEqual({ status: "allowed" });
    expect(await waitlistCount()).toBe(before);
  });

  it("puts anyone else on the list once, and tells them and the owner through Resend", async () => {
    const env = {
      AUTH_ALLOWED_EMAILS: "m@blode.co",
      RESEND_AUDIENCE_ID: "aud_1",
      WAITLIST_NOTIFY_EMAIL: "owner@example.com",
    };
    const mail = outbox();
    const first = await requestAccess(
      { email: "new@example.com", source: "marketing" },
      { env, invited: notInvited, resend: mail },
    );
    expect(first).toEqual({ created: true, notified: true, status: "waitlisted" });
    expect(mail.sent.map((m) => m.to)).toEqual(["new@example.com", "owner@example.com"]);
    expect(mail.contacts).toEqual(["new@example.com"]);
    // Asking again is not a second row and not a second email.
    const again = await requestAccess(
      { email: "NEW@example.com", source: "login" },
      { env, invited: notInvited, resend: mail },
    );
    expect(again).toEqual({ created: false, notified: true, status: "waitlisted" });
    expect(mail.sent).toHaveLength(2);
  });

  it("keeps the row when Resend is down, and says the mail did not go", async () => {
    const env = { AUTH_ALLOWED_EMAILS: "m@blode.co" };
    const broken: ResendClient = {
      addContact: async () => {},
      send: async () => {
        throw new Error("resend down");
      },
    };
    const first = await requestAccess(
      { email: "later@example.com", source: "login" },
      { env, invited: notInvited, resend: broken },
    );
    expect(first).toEqual({ created: true, notified: false, status: "waitlisted" });
    // The next attempt retries the mail because nothing recorded it as sent.
    const mail = outbox();
    const second = await requestAccess(
      { email: "later@example.com", source: "login" },
      { env, invited: notInvited, resend: mail },
    );
    expect(second).toEqual({ created: false, notified: true, status: "waitlisted" });
    expect(mail.sent[0]?.to).toBe("later@example.com");
  });
});
