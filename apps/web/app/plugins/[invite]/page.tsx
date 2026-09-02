import type { Metadata } from "next";

import { InviteNotice } from "@/components/invite-notice";
import { InvitePlugins } from "@/components/invite-plugins";
import { loadStoredInvite } from "@/lib/invite-store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Plugins",
};

export default async function PluginsInvitePage({
  params,
}: {
  params: Promise<{ invite: string }>;
}): Promise<React.ReactElement> {
  const { invite } = await params;
  const loaded = await loadStoredInvite(invite, "plugins");
  if ("error" in loaded) {
    return (
      <InviteNotice
        message={loaded.error}
        title={
          loaded.status === 410
            ? "Link expired"
            : loaded.status === 502
              ? "Computer unavailable"
              : "Link not valid"
        }
      />
    );
  }
  return <InvitePlugins computerId={loaded.computerId} inviteToken={invite} label={loaded.label} />;
}
