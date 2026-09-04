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
 * The block for this turn. Every failure is "no profile yet": a Bot whose
 * identity could not be read still has to answer, and the instructions
 * already tell it to say its brief is empty and ask rather than invent one.
 */
export async function botIdentityPrompt(): Promise<string | undefined> {
  const id = botId();
  if (!id) {
    return undefined;
  }
  try {
    const { content } = await hubRpc<{ content: string }>("readFile", { path: profilePath(id) });
    return identityPrompt(id, content);
  } catch {
    return undefined;
  }
}
