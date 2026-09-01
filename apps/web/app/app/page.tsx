import { redirect } from "next/navigation";

import { App } from "@/app-shell";
import { socialProvidersAvailable } from "@/lib/social-providers";
import { getSessionCached } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppPage() {
  const session = await getSessionCached();
  if (!session) redirect("/login");

  const social = socialProvidersAvailable();
  return <App appleEnabled={social.apple} googleEnabled={social.google} />;
}
