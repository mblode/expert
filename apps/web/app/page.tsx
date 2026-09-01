import { App } from "@/app-shell";
import { MarketingHome } from "@/components/marketing/home-page";
import { socialProvidersAvailable } from "@/lib/social-providers";
import { getSessionCached } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getSessionCached();
  if (!session) return <MarketingHome />;

  const social = socialProvidersAvailable();
  return <App appleEnabled={social.apple} googleEnabled={social.google} />;
}
