import { BOT_TEMPLATE_MAX, parseBotTemplate } from "@computer/shared";
import type { BotTemplate } from "@computer/shared";

/**
 * Making a template generic: the difference between a copy of your Bot and a
 * Bot someone else can use.
 *
 * A working Bot is full of one person. Its brief names their product, its
 * skills name their repository and their spreadsheet, its memory is a list of
 * facts about them, and its description says "the human" but means one human
 * in particular. Published verbatim that is both useless to a stranger, since
 * half the procedures reference things they do not have, and a leak.
 *
 * **The rewrite is the Bot's own model, and nothing here is a pattern match.**
 * It runs inside that Bot's Eve (`apps/eve/lib/channels/template.ts`) on the
 * model its `agent.ts` names, because taking the person out of a setup is
 * judgement rather than search-and-replace: knowing that "the Done Bear board"
 * is this owner's product while "the week view" is anybody's calendar is not
 * something a rule can be written for, and a rule that tried would either miss
 * the first or mangle the second while leaving the owner believing the
 * document had been cleaned.
 *
 * What stays here is the containment, which is not the same as doing the work.
 * The answer is a proposal from a model, so the hub walks its own entries and
 * takes the rewritten text only for ids it sent: the model may rewrite and it
 * may drop, it cannot add. Everything goes back through `parseBotTemplate`.
 * And memory never travels in a generic template at all, because a fact a Bot
 * kept about the person it works for is about that person however it is
 * worded.
 *
 * When the Bot's Eve cannot answer, the caller is told the rewrite did not run
 * rather than handed the verbatim document as though it had. A person who
 * ticked "make it generic" and got their own name back is the one failure this
 * module exists to prevent.
 */

/**
 * Ask a Bot's own Eve to rewrite its setup.
 *
 * A function rather than a URL, for the reason `wake` is one: which port a
 * Bot's Eve listens on and what secret opens it are the host's questions, and
 * `app.ts` is where both are already known. Throws when the Bot has no Eve,
 * when it will not answer, or when the model failed.
 */
export type AskEveFn = (botId: string, template: BotTemplate) => Promise<unknown>;

interface GenericResult {
  template: BotTemplate;
  /** What was left out, in one sentence, for the person publishing. */
  dropped: string;
}

/** Rewrite a template for a stranger, through the Bot it belongs to. */
export async function generaliseTemplate(
  botId: string,
  template: BotTemplate,
  askEve: AskEveFn,
): Promise<GenericResult> {
  return applyRewrite(template, parseRewrite(await askEve(botId, template)));
}

interface Rewritten {
  name: string;
  use_when: string;
  body: string;
}

interface Rewrite {
  name: string;
  title: string;
  description: string;
  instructions: string;
  skills: Map<string, Rewritten>;
  routines: Map<string, { title: string; prompt: string }>;
  dropped: string;
}

/**
 * The Eve route's answer.
 *
 * Strict about the shape and about the name, because an answer this cannot
 * read has to become "the rewrite did not run" rather than a half-applied
 * one: half a rewrite reads as clean and is not.
 */
export function parseRewrite(value: unknown): Rewrite {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("template rewrite answered with no object");
  }
  const o = value as Record<string, unknown>;
  const name = str(o.name);
  if (!name) {
    throw new Error("template rewrite answered with no name");
  }
  const skills = new Map<string, Rewritten>();
  for (const entry of array(o.skills)) {
    const id = str(entry.id);
    if (id) {
      skills.set(id, {
        body: str(entry.body),
        name: str(entry.name),
        use_when: str(entry.use_when),
      });
    }
  }
  const routines = new Map<string, { title: string; prompt: string }>();
  for (const entry of array(o.routines)) {
    const id = str(entry.id);
    if (id) {
      routines.set(id, { prompt: str(entry.prompt), title: str(entry.title) });
    }
  }
  return {
    description: str(o.description),
    dropped: str(o.dropped),
    instructions: str(o.instructions),
    name,
    routines,
    skills,
    title: str(o.title),
  };
}

/**
 * The rewrite, applied to the document rather than trusted as one.
 *
 * The hub walks its own entries and takes the rewritten text for the ones the
 * model returned, so an id that was never sent is not a skill, whatever the
 * answer says. That is the containment: the model's judgement decides what is
 * kept and how it reads, never what exists.
 */
function applyRewrite(t: BotTemplate, rewrite: Rewrite): GenericResult {
  const template = parseBotTemplate({
    avatar_color: t.avatar_color,
    avatar_shape: t.avatar_shape,
    description: rewrite.description || t.description,
    instructions: rewrite.instructions || t.instructions,
    memories: [],
    name: rewrite.name,
    plugins: t.plugins,
    routines: t.routines.flatMap((routine) => {
      const written = rewrite.routines.get(routine.id);
      return written
        ? [
            {
              ...routine,
              prompt: written.prompt || routine.prompt,
              title: written.title || routine.title,
            },
          ]
        : [];
    }),
    skills: t.skills.flatMap((skill) => {
      const written = rewrite.skills.get(skill.id);
      return written
        ? [
            {
              ...skill,
              body: written.body || skill.body,
              name: written.name || skill.name,
              use_when: written.use_when || skill.use_when,
            },
          ]
        : [];
    }),
    title: rewrite.title,
    version: t.version,
  });
  return { dropped: rewrite.dropped.slice(0, BOT_TEMPLATE_MAX.routine_title), template };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function array(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter(
        (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
      )
    : [];
}
