import { headers } from "next/headers";
import { cache } from "react";

import { auth } from "@/lib/auth";

export const getSessionCached = cache(async () => auth.api.getSession({ headers: await headers() }));
