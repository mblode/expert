import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dbCredentials: {
    authToken: process.env.TURSO_AUTH_TOKEN,
    url: process.env.TURSO_DATABASE_URL ?? "",
  },
  dialect: "turso",
  out: "./drizzle",
  schema: [
    "./db/schema.ts",
    "./db/computer.ts",
    "./db/computer-seat.ts",
    "./db/invite.ts",
    "./db/bot-template.ts",
    "./db/onboarding.ts",
    "./db/waitlist.ts",
  ],
});
