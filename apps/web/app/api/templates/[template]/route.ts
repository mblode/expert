import { deleteTemplate, replaceTemplate, setPublished } from "@/lib/bot-template-store";
import { templateView } from "@/lib/bot-template";
import { getSessionCached } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Mint the link, or turn it off again.
 *
 * Publishing is the one irreversible-feeling step in the flow, so it is its
 * own call rather than a field on the save: the person shares a Bot, looks at
 * what is in it, and only then decides that strangers may read it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ template: string }> },
): Promise<Response> {
  const session = await getSessionCached();
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const { template } = await params;
  const body: unknown = await request.json().catch(() => null);
  const published =
    body && typeof body === "object" && "published" in body ? Boolean(body.published) : undefined;
  if (published === undefined) {
    return Response.json({ error: "Say whether to publish it." }, { status: 400 });
  }
  const updated = await setPublished(template, session.user.id, published);
  if ("error" in updated) {
    return Response.json({ error: updated.error }, { status: updated.status });
  }
  return Response.json(templateView(updated));
}

/**
 * Re-read a Bot into a template that has already been shared, at the same
 * link. Bots already made from it are not touched: they are their owners'.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ template: string }> },
): Promise<Response> {
  const session = await getSessionCached();
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const { template } = await params;
  const body: unknown = await request.json().catch(() => null);
  const doc =
    body && typeof body === "object" && "template" in body
      ? (body as { template: unknown }).template
      : undefined;
  const updated = await replaceTemplate(template, session.user.id, doc);
  if ("error" in updated) {
    return Response.json({ error: updated.error }, { status: updated.status });
  }
  return Response.json(templateView(updated));
}

/** Deleting the template turns its link off. Nothing already installed changes. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ template: string }> },
): Promise<Response> {
  const session = await getSessionCached();
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const { template } = await params;
  const deleted = await deleteTemplate(template, session.user.id);
  if ("error" in deleted) {
    return Response.json({ error: deleted.error }, { status: deleted.status });
  }
  return Response.json(deleted);
}
