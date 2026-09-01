import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { customSession, emailOTP } from "better-auth/plugins";

import { getOrCreateComputerSeat } from "./computer-seat";
import { db } from "./db";
import { sendOtpEmail } from "./email";
import { appleSocialConfig, googleSocialConfig } from "./social-providers";

const HUB_ORIGIN = "https://mblode-computer.fly.dev";
const PRODUCT_ORIGINS = ["https://hello.expert", "https://www.hello.expert"];
const isProduction = process.env.VERCEL_ENV === "production";
const isBuild = process.env.NEXT_PHASE === "phase-production-build";

const canonicalOrigin = (
  process.env.BETTER_AUTH_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : undefined) ??
  "http://localhost:3000"
).replace(/\/+$/u, "");

const baseURL = isProduction
  ? canonicalOrigin
  : (process.env.BETTER_AUTH_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined));

const staticTrustedOrigins = [
  ...new Set([
    canonicalOrigin,
    HUB_ORIGIN,
    ...PRODUCT_ORIGINS,
    ...(isProduction ? [] : ["https://*.vercel.app"]),
  ]),
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
  appName: "Expert",
  baseURL,
  database: drizzleAdapter(db, { provider: "sqlite" }),
  plugins: [
    emailOTP({
      sendVerificationOTP: async ({ email, otp, type }) => {
        await sendOtpEmail({ email, otp, type });
      },
      storeOTP: "hashed",
    }),
    // Seat token on the session so a signed-in user is already attached to the box.
    customSession(async ({ user, session }) => {
      const seat = await getOrCreateComputerSeat(user.id);
      return {
        hubUrl: seat.hubUrl,
        seatError: seat.seatError,
        seatToken: seat.seatToken,
        session,
        user,
      };
    }),
  ],
  secret:
    process.env.BETTER_AUTH_SECRET ??
    (isBuild || process.env.NODE_ENV !== "production" ? "dev-only-secret-set-BETTER_AUTH_SECRET" : undefined),
  socialProviders: {
    ...(google ? { google } : {}),
    ...(apple ? { apple } : {}),
  },
  trustedOrigins,
});
