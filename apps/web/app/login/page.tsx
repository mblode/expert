import { redirect } from "next/navigation";

import { LoginGate } from "@/components/login-gate";
import { Navbar } from "@/components/shared/navbar";
import { socialProvidersAvailable } from "@/lib/social-providers";
import { getSessionCached } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await getSessionCached();
  if (session) redirect("/");

  const social = socialProvidersAvailable();

  return (
    <div className="marketing min-h-full">
      <Navbar />
      <main className="flex min-h-svh items-center justify-center px-4 pt-20 pb-16">
        <div className="w-full max-w-sm space-y-5">
          <div>
            <h1 className="font-display text-3xl font-light tracking-tight">Sign in</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Email a one-time code. The computer connects automatically.
            </p>
          </div>
          <LoginGate appleEnabled={social.apple} googleEnabled={social.google} />
        </div>
      </main>
    </div>
  );
}
