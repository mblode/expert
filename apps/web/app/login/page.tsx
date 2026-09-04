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

/**
 * Where to go after signing in.
 *
 * A path on this site and nothing else: `next` arrives in a link someone was
 * sent, so anything that could be read as an origin is dropped rather than
 * followed. A protocol-relative `//host` is the one that looks relative and
 * is not.
 */
function safeNext(value: string | string[] | undefined): string {
  const raw = typeof value === "string" ? value : "";
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const next = safeNext(query.next);
  const session = await getSessionCached();
  if (session) {
    redirect(next);
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
          <LoginForm appleEnabled={social.apple} googleEnabled={social.google} next={next} />
        </div>
      </main>
    </div>
  );
}
