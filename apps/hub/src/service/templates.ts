import { BOT_TEMPLATE_VERSION, parseBotTemplate } from "@computer/shared";
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

export class BotTemplateService {
  constructor(private readonly source?: TemplateSourceReader) {}

  /**
   * Who this Bot is, as a document someone else could install.
   *
   * Memories come out with everything else rather than behind a flag: the
   * caller is an owner seat reading its own computer, and what to publish is
   * a decision made in front of a person who can see the list, not one the
   * hub can make for them. hello.expert shows every section with a tick
   * beside it before anything is stored.
   */
  async export(botId: string, state: BotState): Promise<BotTemplate> {
    const shipped = this.source?.(botId);
    const profile = await state.profile();
    const [instructions, skills, routines, plugins, memories] = await Promise.all([
      state.instructions(),
      state.skills(),
      state.routines(),
      state.plugins(),
      state.memories(),
    ]);
    return parseBotTemplate({
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
