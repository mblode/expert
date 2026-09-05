import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { customSession, emailOTP } from "better-auth/plugins";

import { hasComputerInvitation } from "./computer-enrollment";
import { getOrCreateComputerSeat } from "./computer-seat";
import { isProductionRuntime, siteConfig, trimSlashes } from "./config";
import { db } from "./db";
import { sendOtpEmail } from "./email";
import { captureServerEvent } from "./posthog-server";
import { appleSocialConfig, googleSocialConfig } from "./social-providers";

const isProduction = process.env.VERCEL_ENV === "production";

const canonicalOrigin = trimSlashes(
  process.env.BETTER_AUTH_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined) ??
    "http://localhost:3000",
);

// Production signs cookies for the canonical origin; a preview deployment is
// its own origin and Better Auth derives it from the request.
const baseURL = isProduction
  ? canonicalOrigin
  : (process.env.BETTER_AUTH_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined));

const staticTrustedOrigins = [
  ...new Set([canonicalOrigin, siteConfig.url, `https://www.${new URL(siteConfig.url).host}`]),
];

// Local dev: reflect any localhost origin so the portless / next port is trusted.
const trustedOrigins = (request?: Request): string[] => {
  if (isProduction || !request) {
    return staticTrustedOrigins;
  }
  const origin = request.headers.get("origin");
  return origin && /^https?:\/\/([\w-]+\.)*localhost(:\d+)?$/u.test(origin)
    ? [...staticTrustedOrigins, origin]
    : staticTrustedOrigins;
};

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret && isProductionRuntime) {
  // Better Auth would otherwise fall back to a published default and sign
  // every session with it.
  throw new Error("BETTER_AUTH_SECRET must be set in production");
}

/**
 * Who may sign in. A signed-in user is bound to a computer (hub + seat).
 * Open sign-up still hands a machine to anyone with an email address.
 * Comma-separated; unset means open, which is only right for a private
 * deployment.
 */
const allowedEmails = new Set(
  (process.env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);
const isAllowed = (email: string): boolean =>
  allowedEmails.size === 0 || allowedEmails.has(email.toLowerCase());
if (allowedEmails.size === 0 && isProductionRuntime) {
  console.warn(
    "[auth] AUTH_ALLOWED_EMAILS is unset: anyone who can receive email can sign in and take a seat",
  );
}

const google = googleSocialConfig();
const apple = appleSocialConfig();

export const auth = betterAuth({
  advanced: {
    database: {
      joins: true,
    },
    ipAddress: {
      ipAddressHeaders: ["x-vercel-forwarded-for", "x-forwarded-for"],
    },
  },
  appName: siteConfig.name,
  baseURL,
  database: drizzleAdapter(db, { provider: "sqlite" }),
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          await captureServerEvent({
            distinctId: session.userId,
            event: "login_completed",
            properties: { source: "server" },
          });
        },
      },
    },
    user: {
      create: {
        before: async (user) => {
          if (!isAllowed(user.email) && !(await hasComputerInvitation(user.email))) {
            throw new APIError("FORBIDDEN", {
              message: "This computer is private. Ask its owner for access.",
            });
          }
          return { data: user };
        },
      },
    },
  },
  plugins: [
    emailOTP({
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (!isAllowed(email) && !(await hasComputerInvitation(email))) {
          return;
        }
        await sendOtpEmail({ email, otp, type });
      },
      storeOTP: "hashed",
    }),
    // Seat token on the session so a signed-in user is already attached to a box.
    customSession(async ({ user, session }) => {
      const seat = await getOrCreateComputerSeat(user.id, user.email);
      return {
        computerId: seat.computerId,
        computers: seat.computers,
        hubUrl: seat.hubUrl,
        seatError: seat.seatError,
        seatToken: seat.seatToken,
        session,
        user,
      };
    }),
  ],
  secret: secret ?? "dev-only-secret-set-BETTER_AUTH_SECRET",
  socialProviders: {
    ...(google ? { google } : {}),
    ...(apple ? { apple } : {}),
  },
  trustedOrigins,
});
