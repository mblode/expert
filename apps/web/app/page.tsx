import { App } from "@/app-shell";
import { MarketingHome } from "@/components/marketing/home-page";
import { Onboarding } from "@/components/onboarding/onboarding";
import { readOnboarding } from "@/lib/onboarding-store";
import { getSessionCached } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getSessionCached();
  if (!session) {
    return <MarketingHome />;
  }
  // The first run is a row, not a cookie: someone who answered on their phone
  // does not answer again on their laptop, and someone who skipped stays
  // skipped. Read here so the workspace never renders behind it for a frame.
  const { done, tools } = await readOnboarding(session.user.id);
  return done ? <App tools={tools} /> : <Onboarding />;
}
