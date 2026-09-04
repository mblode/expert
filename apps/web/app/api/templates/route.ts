import { accessibleComputers } from "@/lib/computers";
import { createTemplate, listTemplates } from "@/lib/bot-template-store";
import { templateView } from "@/lib/bot-template";
import { getSessionCached } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The templates this account has made, newest first.
 *
 * The list is the owner's, so it carries the draft ones too: a template with
 * no link yet is the thing the share sheet is in the middle of, and hiding it
 * would make a reload look like the work was lost.
 */
export async function GET(): Promise<Response> {
  const session = await getSessionCached();
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const rows = await listTemplates(session.user.id);
  return Response.json({
    templates: rows.map((row) => ({ ...templateView(row), botId: row.botId })),
  });
}

/**
 * Save a Bot's setup as a template, unpublished.
 *
 * The document comes from the browser rather than from the hub, and that is
 * not a hole: it was read out of the owner's own computer with their own seat
 * a moment earlier, they then ticked which parts of it to include, and this
 * end clamps it before it is stored. What the server does check is the
 * computer, because `computerId` is the one field a person could retype into
 * a claim about someone else's machine.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getSessionCached();
  if (!session?.user?.id || !session.user.email) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Send a template." }, { status: 400 });
  }
  const { botId, computerId, template } = body as Record<string, unknown>;
  if (typeof botId !== "string" || !botId.trim()) {
    return Response.json({ error: "Say which Bot this came from." }, { status: 400 });
  }
  const allowed = accessibleComputers(session.user.email, process.env);
  const computer = allowed.find((row) => row.id === computerId);
  if (!computer) {
    return Response.json({ error: "That computer is not yours." }, { status: 403 });
  }
  const created = await createTemplate({
    botId: botId.trim(),
    computerId: computer.id,
    ownerId: session.user.id,
    template,
  });
  if ("error" in created) {
    return Response.json({ error: created.error }, { status: created.status });
  }
  return Response.json(templateView(created), { status: 201 });
}
