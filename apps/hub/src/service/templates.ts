import { BOT_TEMPLATE_VERSION, parseBotTemplate } from "@computer/shared";
import { generaliseTemplate, scrubTemplate } from "./template-generic.ts";
import type { GenericConfig } from "./template-generic.ts";
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
     * The model that rewrites a template for a stranger. Absent (no
     * `AI_GATEWAY_API_KEY`) means an export can still be scrubbed but never
     * rewritten, and says so rather than pretending.
     */
    private readonly generic?: GenericConfig | null,
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
   * `generic` asks for the other half of that (`service/template-generic.ts`):
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
    if (!this.generic) {
      // Scrubbed but not rewritten, and named as such. The addresses and
      // phone numbers are gone; whose product this is, is not.
      return {
        generic: false,
        note: "This computer has no model to rewrite the template with, so it is your Bot as it is, with email addresses and phone numbers removed. Read it before you publish it.",
        template: scrubTemplate(verbatim),
      };
    }
    try {
      const { dropped, template } = await generaliseTemplate(verbatim, this.generic);
      return {
        generic: true,
        note: dropped,
        template,
      };
    } catch (error) {
      // Never the verbatim document under the generic flag: say the rewrite
      // did not happen and hand back the one thing that is still true, which
      // is the scrub.
      return {
        generic: false,
        note: `The rewrite did not run (${(error as Error).message}), so this is your Bot with email addresses and phone numbers removed. Read it before you publish it.`,
        template: scrubTemplate(verbatim),
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
