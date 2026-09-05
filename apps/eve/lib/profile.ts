/**
 * Who this Bot is, folded into its own system prompt at turn time.
 *
 * A Bot made from `Seat.CreateBot` has no directory: it runs the template
 * project, so its code is identical to every other runtime Bot's and the only
 * thing that makes it a different agent is its profile. The hub keeps that
 * profile at `/workspace/.bots/<id>/profile.json` and the human edits it from
 * the settings sheet, so it has to be read on the box rather than compiled in.
 *
 * It is read through the hub's `ReadFile` rather than `node:fs` on purpose:
 * on the guest `/workspace` is a real path this process can see, but under
 * `npm run up` the desk is a container and the volume is only reachable
 * through the hub. One door works in both.
 *
 * The profile is not the whole of it. A Bot installed from a shared template
 * also has a brief and skills on the box (`instructions.md`, `skills.json`
 * beside `skills/<id>.md`), written by `Seat.ApplyBotTemplate`, and they are
 * read here for the same reason the profile is: they are what makes two Bots
 * on one project different agents, and nothing else would ever read them.
 * Skill *bodies* stay on disk and out of the prompt: a skill is a procedure
 * to open when it is wanted, and five of them in every turn is a context
 * window spent on work that is not being done.
 */

import { hubRpc } from "./hub.ts";

/** Mirrors BOX_STATE_ROOT in the hub's `service/state.ts`. */
const BOT_STATE_ROOT = "/workspace/.bots";

/** Mirrors BOT_PROFILE_MAX in `@computer/shared`. The file is the model's to rewrite. */
const MAX = { description: 500, name: 48, title: 64 } as const;

/** The Bot this Eve process is. The hub's supervisor sets it beside the token. */
function botId(): string | undefined {
  return process.env.COMPUTER_BOT_ID?.trim() || undefined;
}

export function profilePath(id: string): string {
  return `${BOT_STATE_ROOT}/${id}/profile.json`;
}

function instructionsPath(id: string): string {
  return `${BOT_STATE_ROOT}/${id}/instructions.md`;
}

function skillsPath(id: string): string {
  return `${BOT_STATE_ROOT}/${id}/skills.json`;
}

/** Mirrors BOT_TEMPLATE_MAX in `@computer/shared`, for the same reason MAX does. */
const TEMPLATE_MAX = { instructions: 8000, skill_name: 64, skill_use_when: 300, skills: 20 };

/** One line per skill: what it is called, where it lives, and when to open it. */
export function skillIndex(id: string, raw: string | undefined): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const lines: string[] = [];
  for (const entry of parsed.slice(0, TEMPLATE_MAX.skills)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const o = entry as Record<string, unknown>;
    const slug = clamp(o.id, 48);
    if (!slug) {
      continue;
    }
    const name = clamp(o.name, TEMPLATE_MAX.skill_name) || slug;
    const useWhen = clamp(o.use_when, TEMPLATE_MAX.skill_use_when);
    lines.push(
      `- ${name} (${BOT_STATE_ROOT}/${id}/skills/${slug}.md)${useWhen ? `: ${useWhen}` : ""}`,
    );
  }
  return lines.length
    ? ["Skills you have. Read one with read_file before you use it:", ...lines].join("\n")
    : undefined;
}

/**
 * The identity block, or nothing when the profile says nothing this Bot does
 * not already know. A Bot named after its own id with no title and no
 * description has not been told what it is for, and the instructions tell it
 * to say so: contributing "You are night-2." there would be noise.
 */
export function identityPrompt(id: string, raw: string | undefined): string | undefined {
  const p = parseProfile(raw);
  const dir = `${BOT_STATE_ROOT}/${id}`;
  const named = (p.name && p.name !== id) || p.title || p.description;
  if (!named) {
    return undefined;
  }
  const lines = [`You are ${p.name || id}${p.title ? `, ${p.title}` : ""}.`];
  if (p.description) {
    lines.push(p.description);
  }
  lines.push(
    `Your own files are in ${dir}. ${dir}/memory/profile.md is your memory: read it at the start of a run, and write a new "- (YYYY-MM-DD) [note] fact" line when something is worth keeping.`,
  );
  return lines.join("\n");
}

/** Read side of the same file the hub validates on the way in and on the way out. */
function parseProfile(raw: string | undefined): {
  name: string;
  title: string;
  description: string;
} {
  if (!raw) {
    return { description: "", name: "", title: "" };
  }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      description: clamp(o.description, MAX.description),
      name: clamp(o.name, MAX.name),
      title: clamp(o.title, MAX.title),
    };
  } catch {
    return { description: "", name: "", title: "" };
  }
}

function clamp(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * The block for this turn. Every failure is "not written yet": a Bot whose
 * identity could not be read still has to answer, and the instructions
 * already tell it to say its brief is empty and ask rather than invent one.
 *
 * Three reads rather than one, and each one stands on its own: a Bot that
 * came with the build has a profile and no template files, a Bot installed
 * from a shared template has all three, and neither should be held up by the
 * other's absence.
 */
export async function botIdentityPrompt(): Promise<string | undefined> {
  const id = botId();
  if (!id) {
    return undefined;
  }
  const [profile, brief, skills] = await Promise.all([
    readBoxFile(profilePath(id)),
    readBoxFile(instructionsPath(id)),
    readBoxFile(skillsPath(id)),
  ]);
  const blocks = [
    identityPrompt(id, profile),
    clamp(brief, TEMPLATE_MAX.instructions) || undefined,
    skillIndex(id, skills),
  ].filter((block): block is string => Boolean(block));
  return blocks.length ? blocks.join("\n\n") : undefined;
}

/** Missing file, unreadable box, hub not answering: all "nothing there yet". */
async function readBoxFile(path: string): Promise<string | undefined> {
  try {
    const { content } = await hubRpc<{ content: string }>("readFile", { path });
    return content;
  } catch {
    return undefined;
  }
}
