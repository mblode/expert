import { siteConfig } from "./config";

type OtpType = "change-email" | "email-verification" | "forget-password" | "sign-in";

const OTP_SUBJECT: Record<OtpType, string> = {
  "change-email": "Confirm your new email",
  "email-verification": "Verify your email",
  "forget-password": "Reset your password",
  "sign-in": `Your ${siteConfig.name} sign-in code`,
};

/**
 * Send a one-time code email through Resend. Without `RESEND_API_KEY` the code
 * is printed to the server console — only ever outside production, where a
 * missing key is a misconfiguration and must not turn the logs into an inbox.
 */
export async function sendOtpEmail({
  email,
  otp,
  type,
}: {
  email: string;
  otp: string;
  type: OtpType;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("RESEND_API_KEY must be set in production");
    }
    console.info(`[auth] OTP for ${email} (${type}): ${otp}`);
    return;
  }

  const from = process.env.AUTH_EMAIL_FROM ?? `${siteConfig.name} <hello@send.blode.co>`;
  const html = `<p>Your ${siteConfig.name} sign-in code is:</p><p style="font-size:24px;letter-spacing:6px;font-weight:600">${otp}</p><p>This code expires in a few minutes. If you did not request it, you can ignore this email.</p>`;
  const text = `Your ${siteConfig.name} sign-in code is ${otp}. It expires in a few minutes.`;

  const response = await fetch("https://api.resend.com/emails", {
    body: JSON.stringify({
      from,
      html,
      subject: OTP_SUBJECT[type],
      text,
      to: email,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to send OTP email: ${response.status} ${body}`);
  }
}
