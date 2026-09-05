import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { botTemplate } from "../db/bot-template";
import { computerEnrollment } from "../db/computer-enrollment";
import { computer } from "../db/computer";
import { computerSeat } from "../db/computer-seat";
import { invite } from "../db/invite";
import { onboarding } from "../db/onboarding";
import { whatsappConnection } from "../db/whatsapp-connection";
import * as schema from "../db/schema";

const url = process.env.TURSO_DATABASE_URL;

// `next build` imports this module while collecting the /api/auth route, and
// libSQL rejects an empty URL, so build/dev fall back to an in-memory database.
// At production runtime a missing URL is a misconfiguration: fail loudly rather
// than silently persist to an ephemeral database.
if (
  !url &&
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  throw new Error("TURSO_DATABASE_URL must be set in production");
}

const client = createClient({
  authToken: process.env.TURSO_AUTH_TOKEN,
  url: url ?? ":memory:",
});

export const db = drizzle(client, {
  schema: {
    ...schema,
    botTemplate,
    computer,
    computerEnrollment,
    computerSeat,
    invite,
    onboarding,
    whatsappConnection,
  },
});
