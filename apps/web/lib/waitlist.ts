import { isAllowedEmail } from "./allowed-emails";
import { hasComputerInvitation } from "./computer-enrollment";
import { isProductionRuntime, siteConfig } from "./config";
import { formatAuthEmailFrom } from "./email";
import { addToWaitlist, markWaitlistNotified } from "./waitlist-store";

/**
 * The gate in front of sign-up.
 *
 * An address that may make an account (`AUTH_ALLOWED_EMAILS`, or a computer
 * invitation) is `allowed` and the sign-in form goes on to send its code.
 * Any other address is a request for a computer: it is stored, told so by
 * email, and the owner is told too. Before this the form for such an address
 * moved to the code step and the code never came, which read as a broken site
 * rather than a closed door.
 *
 * Resend is the outbox: a confirmation to the person, a note to
 * `WAITLIST_NOTIFY_EMAIL` (default `m@blode.co`), and, when
 * `RESEND_AUDIENCE_ID` is set, the address as a contact in that audience so
 * a "your computer is ready" send later is one broadcast rather than a
 * script. Mail is best effort: the row is the record, and a Resend outage
 * must not turn a joined waitlist into an error on the form.
 */

type AccessDecision =
  | { status: "allowed" }
  | { status: "waitlisted"; created: boolean; notified: boolean }
  | { status: "invalid"; error: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DEFAULT_NOTIFY = "m@blode.co";

export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export interface ResendClient {
  send(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void>;
  addContact(email: string, audienceId: string): Promise<void>;
}

/** Resend over its REST API, the way `sendOtpEmail` already talks to it. */
function resendFromEnv(env: Record<string, string | undefined> = process.env): ResendClient | null {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    if (isProductionRuntime) throw new Error("RESEND_API_KEY must be set in production");
    return null;
  }
  const call = async (path: string, body: unknown): Promise<void> => {
    const response = await fetch(`https://api.resend.com${path}`, {
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Resend ${path}: ${response.status} ${text}`);
    }
  };
  return {
    addContact: (email, audienceId) =>
      call(`/audiences/${audienceId}/contacts`, { email, unsubscribed: false }),
    send: (message) => call("/emails", message),
  };
}

export async function requestAccess(
  input: { email: unknown; source: string },
  deps: {
    env?: Record<string, string | undefined>;
    invited?: (email: string) => Promise<boolean>;
    resend?: ResendClient | null;
  } = {},
): Promise<AccessDecision> {
  const env = deps.env ?? process.env;
  const email = normaliseEmail(input.email);
  if (!email) {
    return { error: "Enter a real email address.", status: "invalid" };
  }
  const invited = deps.invited ?? hasComputerInvitation;
  if (isAllowedEmail(email, env) || (await invited(email))) {
    return { status: "allowed" };
  }
  const { created, notifiedAt } = await addToWaitlist(email, input.source);
  if (notifiedAt) {
    return { created, notified: true, status: "waitlisted" };
  }
  const resend = deps.resend === undefined ? resendFromEnv(env) : deps.resend;
  if (!resend) {
    console.info(`[waitlist] ${email} joined (${input.source}); no RESEND_API_KEY, nothing sent`);
    return { created, notified: false, status: "waitlisted" };
  }
  const from = formatAuthEmailFrom(env.AUTH_EMAIL_FROM);
  const notify = env.WAITLIST_NOTIFY_EMAIL?.trim() || DEFAULT_NOTIFY;
  try {
    await resend.send({
      from,
      html: `<p>You're on the list for ${siteConfig.name}.</p><p>A computer of your own, with a team of Bots on it, is handed out one at a time. You'll get an email at this address when yours is ready. Nothing to do until then.</p>`,
      subject: `You're on the ${siteConfig.name} list`,
      text: `You're on the list for ${siteConfig.name}. You'll get an email at this address when your computer is ready. Nothing to do until then.`,
      to: email,
    });
    const audience = env.RESEND_AUDIENCE_ID?.trim();
    if (audience) {
      await resend.addContact(email, audience).catch((error: unknown) => {
        console.warn(`[waitlist] audience add failed for ${email}: ${String(error)}`);
      });
    }
    await resend
      .send({
        from,
        html: `<p><strong>${email}</strong> joined the waitlist from <code>${input.source}</code>.</p>`,
        subject: `Waitlist: ${email}`,
        text: `${email} joined the waitlist from ${input.source}.`,
        to: notify,
      })
      .catch((error: unknown) => {
        console.warn(`[waitlist] owner notify failed: ${String(error)}`);
      });
    await markWaitlistNotified(email);
    return { created, notified: true, status: "waitlisted" };
  } catch (error) {
    console.warn(`[waitlist] confirmation to ${email} failed: ${String(error)}`);
    return { created, notified: false, status: "waitlisted" };
  }
}
