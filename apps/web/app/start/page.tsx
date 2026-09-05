import Link from "next/link";
import type { Metadata } from "next";
import { ClaimComputer, ComputerInvitation, SetupReady } from "@/components/onboarding/setup";
import { isComputerOperator } from "@/lib/computers";
import { getSessionCached } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Set up your assistant",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token =
    typeof params.invite === "string" && /^[A-Za-z0-9_-]{43}$/u.test(params.invite)
      ? params.invite
      : "";
  const phoneToken =
    typeof params.claim === "string" && /^[A-Za-z0-9_-]{43}$/u.test(params.claim)
      ? params.claim
      : "";
  const destination = phoneToken
    ? `/start?claim=${phoneToken}`
    : token
      ? `/start?invite=${token}`
      : "/start";
  const session = await getSessionCached();
  return (
    <main className="mx-auto min-h-dvh max-w-lg space-y-6 px-6 py-16">
      <Link href="/" className="inline-flex min-h-12 items-center text-sm text-muted-foreground">
        Expert
      </Link>
      <h1 className="text-3xl font-semibold tracking-tight">Your assistant starts here</h1>
      {session ? (
        session.seatToken ? (
          <SetupReady />
        ) : phoneToken ? (
          <ClaimComputer token={phoneToken} phone />
        ) : token ? (
          <ClaimComputer token={token} />
        ) : (
          <div className="space-y-3">
            <p>
              {session.computerId
                ? "Your computer is not responding yet. Your workspace is still reserved."
                : "Message Vibey on WhatsApp to start your private assistant. Send “workspace” in the chat whenever you want to connect it here."}
            </p>
            {session.computerId && (
              <Link href="/" className="inline-flex min-h-12 items-center underline">
                Retry connection
              </Link>
            )}
          </div>
        )
      ) : (
        <div className="space-y-4">
          <p>
            {phoneToken
              ? "Sign in to open your WhatsApp assistant’s workspace."
              : "Message Vibey on WhatsApp. Your private assistant is set up automatically."}
          </p>
          {!phoneToken && !token && (
            <Link
              className="inline-flex min-h-12 items-center underline"
              href="https://wa.me/message/O7KCFC6HSFCPM1"
            >
              Message Vibey
            </Link>
          )}
          <Link
            className="inline-flex min-h-12 items-center underline"
            href={`/login?next=${encodeURIComponent(destination)}`}
          >
            Sign in to continue
          </Link>
        </div>
      )}
      {session && isComputerOperator(session.user.email, process.env) && (
        <details className="space-y-4 border-t border-edge pt-6">
          <summary className="min-h-12 cursor-pointer py-3 text-sm text-muted-foreground">
            Invite someone
          </summary>
          <ComputerInvitation />
        </details>
      )}
    </main>
  );
}
