import { redirect } from "next/navigation";
import Link from "next/link";
import { App } from "@/app-shell";
import { getSessionCached } from "@/lib/session";
import { parseWorkTarget, workTargetMatches } from "@/lib/work-target";

export const dynamic = "force-dynamic";

export default async function WorkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const target = parseWorkTarget(params);
  if (!target)
    return <p className="p-6">This work link is incomplete. Ask your assistant for a new one.</p>;
  const session = await getSessionCached();
  if (!session) {
    const query = new URLSearchParams(
      Object.entries(params).filter(
        (pair): pair is [string, string] => typeof pair[1] === "string",
      ),
    );
    redirect(`/login?returnTo=${encodeURIComponent(`/work?${query}`)}`);
  }
  if (!session.hubUrl || !workTargetMatches(target, session.hubUrl)) {
    return (
      <div className="space-y-3 p-6">
        <p>
          This work belongs to a different computer. Open your workspace and select the correct
          account before following this link.
        </p>
        <Link href="/">Open workspace</Link>
      </div>
    );
  }
  return <App initialTarget={target} />;
}
