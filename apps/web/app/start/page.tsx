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
        ) : token ? (
          <ClaimComputer token={token} />
        ) : (
          <div className="space-y-3">
            <p>
              {session.computerId
                ? "Your computer is not responding yet. Your workspace is still reserved."
                : "Expert is opening in small batches. Use your personal setup invitation to claim a computer."}
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
          <p>Sign in with your invited email to set up your private workspace.</p>
          <Link
            className="inline-flex min-h-12 items-center underline"
            href={`/login?next=${encodeURIComponent(token ? `/start?invite=${token}` : "/start")}`}
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
