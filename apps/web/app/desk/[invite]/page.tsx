import { InviteDesk } from "@/components/invite-desk";
import { InviteNotice } from "@/components/invite-notice";
import { redeemStoredInvite } from "@/lib/invite-store";

export const dynamic = "force-dynamic";

export default async function DeskInvitePage({
  params,
}: {
  params: Promise<{ invite: string }>;
}): Promise<React.ReactElement> {
  const { invite } = await params;
  const granted = await redeemStoredInvite(invite, "desk");
  if ("error" in granted) {
    return (
      <InviteNotice
        message={granted.error}
        title={
          granted.status === 410
            ? "Link expired"
            : granted.status === 502
              ? "Computer unavailable"
              : "Link not valid"
        }
      />
    );
  }
  return (
    <InviteDesk
      computerId={granted.computerId}
      hubUrl={granted.hubUrl}
      inviteToken={invite}
      label={granted.computer.label}
      seatToken={granted.seatToken}
    />
  );
}
