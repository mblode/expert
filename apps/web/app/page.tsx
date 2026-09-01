import { App } from "@/app-shell";
import { socialProvidersAvailable } from "@/lib/social-providers";

export const dynamic = "force-dynamic";

export default function Page() {
  const social = socialProvidersAvailable();
  return <App appleEnabled={social.apple} googleEnabled={social.google} />;
}
