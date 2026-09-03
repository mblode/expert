import { accessibleComputers, computerById, isComputerOperator } from "@/lib/computers";
import { ensureComputerCatalog } from "@/lib/computer-seat";
import { bootstrapIssuer, hasIssuer } from "@/lib/issuer";
import { getSessionCached } from "@/lib/session";

/**
 * Bootstrap the control plane's `issuer` on one computer, once.
 *
 * This is the only route that spends a setup code, and it is the only reason
 * one is still in env. Grants refuse when there is no issuer rather than
 * coming here on their own: pairing an owner is an operator's decision, not
 * something an invite redemption does behind their back.
 *
 * Operators only, because it is per computer and an operator is who can see
 * every computer. It answers `ready` or an error sentence and never the
 * credential itself.
 */
export async function GET(): Promise<Response> {
  const session = await getSessionCached();
  const email = session?.user?.email;
  if (!email || !isComputerOperator(email, process.env)) {
    return Response.json({ error: "Not allowed." }, { status: 403 });
  }
  const computers = await Promise.all(
    accessibleComputers(email, process.env).map(async (computer) => ({
      id: computer.id,
      label: computer.label,
      ready: await hasIssuer(computer),
    })),
  );
  return Response.json({ computers });
}

export async function POST(request: Request): Promise<Response> {
  const session = await getSessionCached();
  const email = session?.user?.email;
  if (!email || !isComputerOperator(email, process.env)) {
    return Response.json({ error: "Not allowed." }, { status: 403 });
  }
  const body: unknown = await request.json().catch(() => null);
  const wanted =
    body && typeof body === "object" && "computerId" in body && typeof body.computerId === "string"
      ? body.computerId.trim()
      : "";
  const computer = computerById(wanted, process.env);
  if (!computer) {
    return Response.json({ error: "That computer is not on this control plane." }, { status: 400 });
  }
  // Keep the catalog row that holds the issuer in step with env first: the
  // bootstrap writes onto that row, and a computer added since the last sign
  // in would have no row to write to.
  await ensureComputerCatalog().catch(() => undefined);
  const result = await bootstrapIssuer(computer, process.env);
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: 502 });
  }
  return Response.json({ computerId: computer.id, issuer: "ready" });
}
