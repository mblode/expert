import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineDynamic, defineSkill } from "eve/skills";

import { tenantDataDir } from "../vibey/chat-archive-source.ts";

/**
 * A load-on-demand skill whose body is a file on the tenant's volume.
 *
 * Vibey's lore, its maintainer's biography and the account of how it is
 * built are skills in the eve sense (advertised by description, loaded when a
 * turn needs them) and tenant content in the product sense (about one
 * community and its people, not shipped to every computer). eve resolves a
 * dynamic skill per file, named after the file's slug, so each tenant skill
 * is one small module here that reads `skills/<slug>.md` under the tenant
 * data directory and returns nothing when the file is absent. A computer
 * with no such file advertises no such skill.
 *
 * The file follows the `SKILL.md` convention this repo's authored skills use:
 * a YAML header with `description` (the routing hint the model sees every
 * turn), then the body. The header parser is deliberately small: one key,
 * plain or folded (`>-`), which is every file the tenant has; anything else
 * falls back to the first line of the body the way eve does for flat files.
 */

interface TenantSkillFile {
  description: string;
  markdown: string;
}

export const SKILLS_DIR = "skills";

const cache = new Map<string, TenantSkillFile | null>();

/** `description:` out of the YAML header, plain or folded, and the body after it. */
export function parseSkillFile(source: string): TenantSkillFile | null {
  const text = source.replaceAll("\r\n", "\n");
  let description = "";
  let body = text;
  const header = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (header) {
    body = text.slice(header[0].length);
    const lines = header[1].split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const match = /^description:\s*(.*)$/.exec(line);
      if (!match) {
        continue;
      }
      const inline = match[1]?.trim() ?? "";
      if (inline && !/^[>|][-+]?$/.test(inline)) {
        description = inline.replaceAll(/^["']|["']$/g, "");
        break;
      }
      // Folded block: every following indented line, joined with spaces.
      const folded: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? "";
        if (!/^\s+\S/.test(next)) {
          break;
        }
        folded.push(next.trim());
      }
      description = folded.join(" ");
      break;
    }
  }
  const markdown = body.trim();
  if (!markdown) {
    return null;
  }
  if (!description) {
    const first = markdown
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("```"));
    description = (first ?? "").replace(/^[#>*-]+\s*/, "");
  }
  return description ? { description, markdown } : null;
}

/** The parsed file for a slug, or null; read once per process. */
export function readTenantSkill(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): TenantSkillFile | null {
  if (!cache.has(slug)) {
    const path = join(tenantDataDir(env), SKILLS_DIR, `${slug}.md`);
    cache.set(slug, existsSync(path) ? parseSkillFile(readFileSync(path, "utf-8")) : null);
  }
  return cache.get(slug) ?? null;
}

/** Test seam: forget every parsed file. */
export const resetTenantSkillCache = (): void => {
  cache.clear();
};

/** The module a `agent/skills/<slug>.ts` file exports for a tenant skill. */
export const tenantSkill = (slug: string) =>
  defineDynamic({
    events: {
      "session.started": () => {
        const file = readTenantSkill(slug);
        return file
          ? defineSkill({ description: file.description, markdown: file.markdown })
          : null;
      },
    },
  });
