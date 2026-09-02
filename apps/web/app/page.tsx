import { App } from "@/app-shell";
import { MarketingHome } from "@/components/marketing/home-page";
import { getSessionCached } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getSessionCached();
  return session ? <App /> : <MarketingHome />;
}
