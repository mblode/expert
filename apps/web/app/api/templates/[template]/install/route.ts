import { countInstall, publishedTemplate } from "@/lib/bot-template-store";
import {
  captureServerEvent,
  distinctIdFromRequest,
  sessionPropertiesFromRequest,
} from "@/lib/posthog-server";
import { getSessionCached } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * A Bot was made from this template.
 *
 * The install itself does not happen here. It happens in the browser, with
 * the person's own seat on their own computer: `CreateBot`, then
 * `ApplyBotTemplate`, which is the same pair of calls the New Bot sheet makes
 * and keeps the control plane out of the business of writing to a hub it does
 * not hold a seat for. This route is what the browser tells afterwards, so
 * the count under a shared template is the number of Bots that exist rather
 * than the number of times a page was opened.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ template: string }> },
): Promise<Response> {
  const session = await getSessionCached();
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const { template } = await params;
  const record = await publishedTemplate(template);
  if (!record) {
    return Response.json({ error: "That template is not here." }, { status: 404 });
  }
  await countInstall(record.id);
  await captureServerEvent({
    distinctId: distinctIdFromRequest(request, session.user.id),
    event: "bot_template_installed",
    properties: {
      source: "server",
      template_id: record.id,
      ...sessionPropertiesFromRequest(request),
    },
  });
  return Response.json({ installs: record.installs + 1 });
}
