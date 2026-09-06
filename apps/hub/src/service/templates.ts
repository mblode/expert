import { BOT_TEMPLATE_MAX, BOT_TEMPLATE_VERSION, parseBotTemplate } from "@computer/shared";
import type {
  BotProfile,
  BotTemplate,
  BotTemplatePlugin,
  BotTemplateRoutine,
  BotTemplateSkill,
} from "@computer/shared";
import type { BotState } from "./state.ts";

/**
 * A Bot's setup, lifted off this computer and dropped onto another.
 *
 * The two halves are deliberately asymmetric. **Export reads two places**:
 * the Bot's own directory on the box, and the Eve project it runs, because a
 * Bot that came with the build keeps its brief, its skills and its schedule
 * in git and a Bot made at runtime keeps them on the volume. Box wins where
 * both answer, the same rule the profile follows, because after the first
 * boot the file is the human's. **Apply writes one place**: the box. Nothing
 * here touches the image, and it must not: `/workspace` is box-writable and
 * the Eve projects are what the build shipped, so a template that could write
 * one would be a link that edits the computer's code.
 *
 * What never travels: tokens, connector secrets, plugin credentials, the
 * conversation, or anything naming the computer it came from. See
 * `BotTemplate` in `packages/shared` for the document itself.
 */
export interface TemplateSource {
  instructions?: string;
  skills: BotTemplateSkill[];
  routines: BotTemplateRoutine[];
  plugins: BotTemplatePlugin[];
}

/**
 * What a Bot's Eve project ships, read from the image by `host/bot-template.ts`.
 * A function rather than a path, for the reason `ProfileSeedReader` is one:
 * the guest layout is `host/`'s question and the service layer never learns a
 * directory.
 */
export type TemplateSourceReader = (botId: string) => TemplateSource | undefined;

/**
 * What an export answers with.
 *
 * `generic` is whether the rewrite actually ran, and it is separate from
 * having asked for it on purpose: a person who ticked "make it generic" and
 * was handed their own name back, because the gateway was down, is the one
 * failure worth this extra field. `note` is the sentence they should read.
 */
interface ExportedTemplate {
  template: BotTemplate;
  generic: boolean;
  note: string;
}

export class BotTemplateService {
  constructor(
    private readonly source?: TemplateSourceReader,
    /**
     * How to reach a Bot's own Eve, which is what rewrites its setup for a
     * stranger. Absent means a hub with no Eve beside it: an export is still
     * whole, it is simply never generic, and it says so rather than
     * pretending.
     */
    private readonly askEve?: AskEveFn,
  ) {}

  /**
   * Who this Bot is, as a document someone else could install.
   *
   * Memories come out with everything else rather than behind a flag: the
   * caller is an owner seat reading its own computer, and what to publish is
   * a decision made in front of a person who can see the list, not one the
   * hub can make for them. hello.expert shows every section with a tick
   * beside it before anything is stored.
   *
   * `generic` asks for the other half of that (`generaliseTemplate`, below):
   * the same Bot with the person taken out of it, which is what makes a
   * template worth sending to someone who does not have your products, your
   * repositories or your colleagues. Memory never survives it.
   */
  async export(
    botId: string,
    state: BotState,
    opts: { generic?: boolean } = {},
  ): Promise<ExportedTemplate> {
    const shipped = this.source?.(botId);
    const profile = await state.profile();
    const [instructions, skills, routines, plugins, memories] = await Promise.all([
      state.instructions(),
      state.skills(),
      state.routines(),
      state.plugins(),
      state.memories(),
    ]);
    const verbatim = parseBotTemplate({
      avatar_color: profile.avatar_color,
      avatar_shape: profile.avatar_shape,
      description: profile.description,
      instructions: instructions || shipped?.instructions || "",
      memories,
      name: profile.name,
      plugins: plugins.length ? plugins : (shipped?.plugins ?? []),
      routines: routines.length ? routines : (shipped?.routines ?? []),
      skills: skills.length ? skills : (shipped?.skills ?? []),
      title: profile.title,
      version: BOT_TEMPLATE_VERSION,
    });
    if (!opts.generic) {
      return { generic: false, note: "", template: verbatim };
    }
    if (!this.askEve) {
      return {
        generic: false,
        note: "This Bot has no Eve to rewrite its setup with, so this is your Bot exactly as it is. Read every section before you publish it.",
        template: verbatim,
      };
    }
    try {
      const { dropped, template } = await generaliseTemplate(botId, verbatim, this.askEve);
      return { generic: true, note: dropped, template };
    } catch (error) {
      // Never the verbatim document as though it had been rewritten. It is
      // handed back because the person may still want it, under a flag and a
      // sentence that say plainly what they are looking at.
      return {
        generic: false,
        note: `${botName(verbatim)} could not rewrite it (${(error as Error).message}), so this is your Bot exactly as it is. Read every section before you publish it.`,
        template: verbatim,
      };
    }
  }

  /**
   * Write a template onto a Bot on this computer.
   *
   * Replacing, not merging, for the four declared sections: a template is a
   * whole setup, and a Bot left holding half of one and half of another is a
   * Bot nobody can reason about. Memory is the exception and is appended,
   * because what a Bot already remembers happened to it and to the person it
   * works for. The caller has just made this Bot in every path that matters,
   * so the replacement is of a template project's defaults.
   *
   * The document is parsed again here even when it was parsed by whoever
   * handed it over. It arrived over a link from a computer this one has never
   * met, the ids in it become filenames, and the strings in it become a
   * system prompt: this is the last place that can still say no.
   */
  async apply(state: BotState, input: unknown): Promise<BotProfile> {
    const template = parseBotTemplate(input);
    const profile = await state.setProfile({
      avatar_color: template.avatar_color,
      avatar_shape: template.avatar_shape,
      description: template.description,
      name: template.name,
      title: template.title,
    });
    await state.setInstructions(template.instructions);
    await state.setSkills(template.skills);
    await state.setRoutines(template.routines);
    await state.setPlugins(template.plugins);
    await state.addMemories(template.memories);
    return profile;
  }
}

/** The Bot in the sentence a person reads, not an id. */
function botName(template: BotTemplate): string {
  return template.name || "This Bot";
}

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
