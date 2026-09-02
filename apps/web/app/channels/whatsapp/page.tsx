import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { WhatsAppChannel } from "@/components/whatsapp-channel";
import { getSessionCached } from "@/lib/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "WhatsApp",
};

/** Owner only: the seat on the session is what the page links with. */
export default async function WhatsAppChannelPage() {
  const session = await getSessionCached();
  if (!session) {
    redirect("/login");
  }
  return <WhatsAppChannel />;
}
