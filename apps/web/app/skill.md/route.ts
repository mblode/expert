import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The agent skill as one plain file, beside the tarball the `npx skills add`
 * flow already fetches from /.well-known/agent-skills/. Read at request
 * time from the public tree, so there is one copy to keep current.
 */
export async function GET(): Promise<Response> {
  const body = await readFile(
    join(process.cwd(), "public/.well-known/agent-skills/expert/SKILL.md"),
    "utf-8",
  ).catch(() => null);
  if (body === null) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "text/markdown; charset=utf-8",
    },
  });
}
