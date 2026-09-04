import type { Metadata } from "next";

import { InviteNotice } from "@/components/invite-notice";
import { TemplatePage } from "@/components/template-page";
import { templateById, publishedTemplate } from "@/lib/bot-template-store";
import { templateView } from "@/lib/bot-template";
import { getSessionCached } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Not indexed, like the invite pages. The link is the whole credential: a
 * published template is readable by anyone who has it and should not be
 * findable by anyone who does not.
 */
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Bot",
};

export default async function BotTemplatePage({
  params,
}: {
  params: Promise<{ template: string }>;
}): Promise<React.ReactElement> {
  const { template } = await params;
  const published = await publishedTemplate(template);
  if (published) {
    return <TemplatePage view={templateView(published)} />;
  }
  // An unpublished template is not found rather than forbidden, so a link
  // that has not been shared yet does not confirm that something is there.
  // Its owner is the one exception: this page is their preview.
  const session = await getSessionCached();
  const draft = session?.user?.id ? await templateById(template) : undefined;
  if (draft && draft.ownerId === session?.user?.id) {
    return <TemplatePage draft view={templateView(draft)} />;
  }
  return (
    <InviteNotice
      message="This template is not shared, or it was taken down."
      title="Not available"
    />
  );
}
