import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { Navbar } from "@/components/shared/navbar";
import { socialProvidersAvailable } from "@/lib/social-providers";
import { getSessionCached } from "@/lib/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { canonical: "/login" },
  title: "Sign in",
};

export default async function LoginPage() {
  const session = await getSessionCached();
  if (session) {
    redirect("/");
  }

  const social = socialProvidersAvailable();

  return (
    <div className="marketing min-h-full">
      <Navbar />
      <main className="flex min-h-svh items-center justify-center px-4 pt-20 pb-16">
        <div className="w-full max-w-sm space-y-5">
          <div>
            <h1 className="font-display text-3xl font-light tracking-tight">Sign in</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              New or returning: email a code. The computer connects.
            </p>
          </div>
          <LoginForm appleEnabled={social.apple} googleEnabled={social.google} />
        </div>
      </main>
    </div>
  );
}
