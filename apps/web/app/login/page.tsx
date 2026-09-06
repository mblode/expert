import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { WhatsAppLoginForm } from "@/components/whatsapp-login-form";
import { Navbar } from "@/components/shared/navbar";
import { socialProvidersAvailable } from "@/lib/social-providers";
import { getSessionCached } from "@/lib/session";
import { workReturnTo } from "@/lib/work-target";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { canonical: "/login" },
  description: `Sign in to Expert with a code from your private WhatsApp chat, or by email. New sign-ups join the waitlist.`,
  // Crawlable so the directive is seen, but not worth a result of its own.
  robots: { follow: true, index: false },
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
  return raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\") ? raw : "/";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const next =
    typeof query.returnTo === "string" ? workReturnTo(query.returnTo) : safeNext(query.next);
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
              Use a code from your private WhatsApp chat.
            </p>
          </div>
          <WhatsAppLoginForm
            appleEnabled={social.apple}
            googleEnabled={social.google}
            next={next}
          />
        </div>
      </main>
    </div>
  );
}
