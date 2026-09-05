import { createHash } from "node:crypto";
import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  BOT_PROFILE_MAX,
  BOT_TEMPLATE_MAX,
  ComputerError,
  MEMORY_MAX_CHARS,
  memoryId,
  parseMemory,
  templateSlug,
  validCron,
} from "@computer/shared";
import type {
  BotProfile,
  BotTemplatePlugin,
  BotTemplateRoutine,
  BotTemplateSkill,
  MessageBody,
} from "@computer/shared";
import type { Desk } from "../desk/types.ts";

/**
 * One line of `transcript.jsonl`: a `MessageBody` with `id`, `seq` and `at`
 * on the outside.
 *
 * This is the shape the hub wrote before conversations existed, and the only
 * thing that still reads it is the one-shot import. It lives here rather
 * than in `voice.ts` because the file it describes lives here.
 */
type Flat<T> = T extends unknown ? T & { id: string; seq: number; at: number } : never;
export type Occurrence = Flat<MessageBody>;

/**
 * Per-Bot state on the box: who this Bot is, what it remembers, what was said.
 *
 * **Where.** Grok Bot keeps this at `/home/box/sand-data/agents/<id>/`. We
 * deliberately do not. `$HOME` is not on a volume here, so `sand-data` would
 * be erased by the next rebuild: the exact row the README's "What survives"
 * table calls out. `/workspace` survives a rebuild, and
 * `/workspace/.window-assignments.json` already sets the precedent for box
 * state living there, for the same reason: a rebuild must not cost a Bot its
 * screen, and it must not cost a human their transcript either.
 *
 * **What is here and what is not.** Profile and memory are on the box, and
 * so is the transcript this hub wrote before conversations existed, now read
 * once at boot and never written again (see `transcriptPath`). The Bot's
 * token never is. `/workspace` is shared by every Bot and read
 * by every agent on the machine, so a per-Bot directory is *organisation, not
 * isolation*, one `box` user, no boundary, and everything written here is
 * readable by every other Bot. Identity and credentials stay host-side in
 * `data/bots.json` (mode 0600); the box only ever sees `sha256(token)`, and
 * only in the window claim.
 *
 * Grok also keeps `settings.json` and `automations/` here. We have neither
 * feature, so neither file: an empty stub is not a contract.
 */
const BOX_STATE_ROOT = "/workspace/.bots";

/** Seeded once. It is the only place the line format is stated to the agent. */
const MEMORY_HEADER = `# Memory

What you want to still know next time. One fact per line, oldest first:

- (YYYY-MM-DD) [note] a durable fact about the human or this computer
- (YYYY-MM-DD) [episode] something that happened

Keep a line under ${MEMORY_MAX_CHARS} characters. Writing a fact you already
wrote changes nothing, an entry is identified by its own text.
`;

export class BotState {
  /** `/workspace/.bots/<id>`: this Bot's directory on the box. */
  readonly dir: string;

  constructor(
    private readonly desk: Desk,
    private readonly botId: string,
  ) {
    this.dir = `${BOX_STATE_ROOT}/${botId}`;
  }

  get profilePath(): string {
    return `${this.dir}/profile.json`;
  }

  get memoryPath(): string {
    return `${this.dir}/memory/profile.md`;
  }

  /**
   * The Bot's brief, its procedures, its schedule and the services it expects,
   * as four files beside the profile.
   *
   * A Bot that came with the build has all of this in its Eve project, in git,
   * where changing it is a deploy. A Bot made at runtime runs the template
   * project, so until now it had nothing but its description: two Bots on one
   * project differed by a paragraph. These are that difference made writable.
   * They are read on every prompt, they are under `/workspace` so the Bot can
   * rewrite them itself with `write_file`, and they are what a template is
   * made of, which is the same fact from the other end: applying a template is
   * writing these files.
   *
   * The project still seeds them. Box wins where both exist, exactly as the
   * profile does, because after the first boot the file is the human's.
   */
  get instructionsPath(): string {
    return `${this.dir}/instructions.md`;
  }

  get skillsPath(): string {
    return `${this.dir}/skills.json`;
  }

  get routinesPath(): string {
    return `${this.dir}/routines.json`;
  }

  get pluginsPath(): string {
    return `${this.dir}/plugins.json`;
  }

  /** One skill's body. The id is slugged by the caller, never a path from a document. */
  skillBodyPath(id: string): string {
    return `${this.dir}/skills/${id}.md`;
  }

  /**
   * JSONL, like Grok's, and now read once and never written again.
   *
   * The hub appended a line here per bubble until conversations landed. The
   * file stays where it is: it is the human's record of what their computer
   * said, it is the only copy, and it is on a volume. `ConversationRegistry`
   * imports it into the Bot's seat conversation at boot and the log moves to
   * the hub's own directory, which the model cannot rewrite.
   */
  get transcriptPath(): string {
    return `${this.dir}/transcript.jsonl`;
  }

  /**
   * Establish the directory. Seeds a profile and a memory file only when they
   * are absent, so a Bot re-created under a name it had before adopts what it
   * left behind rather than overwriting it.
   *
   * `seed` is who the Bot ships as: the profile its Eve project carries in
   * git, so a Bot that arrives with a deploy already has its name, its label
   * and its mark the first time a client lists the roster, rather than
   * showing up as its own id in a hashed colour. It is a seed and not a
   * default: the file wins on every later boot, because after the first one
   * it is the human's and the Bot's, and a deploy must not reset a rename.
   * Every field is validated the way a read is, so a bad seed degrades to the
   * hashed default rather than failing the boot it happens during.
   */
  async init(seed?: Partial<BotProfile>): Promise<void> {
    if (!(await this.read(this.profilePath))) {
      await this.desk.writeFile(
        this.profilePath,
        `${JSON.stringify(seededProfile(this.botId, seed), null, 2)}\n`,
      );
    }
    if (!(await this.read(this.memoryPath))) {
      await this.desk.writeFile(this.memoryPath, MEMORY_HEADER);
    }
  }

  /**
   * Who this Bot is, clamped.
   *
   * The agent can edit this file (it is under `/workspace`, so `write_file`
   * reaches it), and this is where the profile leaves the box for `/roster`
   * and from there into a client that renders the colour as an inline style.
   * So every field is untrusted on the way out, not only on the way in: an
   * unknown shape or colour falls back to the seeded one and the strings are
   * truncated rather than dropped.
   *
   * The system prompt does not come through here. A Bot's Eve reads the same
   * file on the box at the start of each turn (`apps/eve/lib/profile.ts`),
   * because the hub's only seam in front of a turn is a byte pass-through
   * proxy and a prompt the hub rendered would have nowhere to go.
   */
  async profile(): Promise<BotProfile> {
    const raw = await this.read(this.profilePath);
    const fallback = defaultProfile(this.botId);
    if (!raw) {
      return fallback;
    }
    try {
      const o = JSON.parse(raw) as Partial<BotProfile>;
      return {
        avatar_color: oneOf(AVATAR_COLORS, o.avatar_color) ?? fallback.avatar_color,
        avatar_shape: oneOf(AVATAR_SHAPES, o.avatar_shape) ?? fallback.avatar_shape,
        description: clamp(o.description, BOT_PROFILE_MAX.description) ?? fallback.description,
        id: this.botId,
        name: clamp(o.name, BOT_PROFILE_MAX.name) ?? fallback.name,
        title: clamp(o.title, BOT_PROFILE_MAX.title) ?? fallback.title,
      };
    } catch {
      return fallback;
    }
  }

  /**
   * The human at the seat edits who this Bot is. Validated here rather than
   * in the handler, because this is the rule and the handler is the parsing.
   *
   * The request carries the whole profile, not a patch: `title` and
   * `description` are cleared by an empty string, and `name`, `avatar_shape`
   * and `avatar_color` must each be given, because proto3 cannot tell an
   * absent string from an empty one and none of the three has a meaningful
   * empty value. Writing the whole file also drops whatever else the agent
   * left in it, which is the point: the profile is a closed shape.
   */
  async setProfile(input: Record<string, unknown>): Promise<BotProfile> {
    const profile: BotProfile = {
      avatar_color: required(AVATAR_COLORS, input.avatar_color, "avatar_color"),
      avatar_shape: required(AVATAR_SHAPES, input.avatar_shape, "avatar_shape"),
      description: field(input.description, "description", BOT_PROFILE_MAX.description),
      id: this.botId,
      name: field(input.name, "name", BOT_PROFILE_MAX.name, { required: true }),
      title: field(input.title, "title", BOT_PROFILE_MAX.title),
    };
    await this.desk.writeFile(this.profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    return profile;
  }

  async memory(): Promise<ReturnType<typeof parseMemory>> {
    return parseMemory((await this.read(this.memoryPath)) ?? "");
  }

  /**
   * Every fact this Bot remembers, as the lines a template carries. The
   * dates are dropped deliberately: a shared memory is a fact the receiving
   * Bot is being told, not a thing that happened to it on a day it was not
   * running.
   */
  async memories(): Promise<string[]> {
    const entries = await this.memory();
    return entries.map((entry) => entry.text);
  }

  /**
   * Add facts this Bot does not already have, oldest first, dated today.
   *
   * Appended rather than written, and by content, because memory is the one
   * part of a Bot that is genuinely its own: installing a template must not
   * erase what the Bot on the receiving computer already knows. `parseMemory`
   * identifies an entry by its text, so a fact it already holds is a no-op.
   */
  async addMemories(facts: readonly string[], today = new Date()): Promise<number> {
    const entries = await this.memory();
    const have = new Set(entries.map((entry) => entry.id));
    const date = today.toISOString().slice(0, 10);
    const lines: string[] = [];
    for (const fact of facts) {
      const text = fact.replaceAll(/\s+/g, " ").trim().slice(0, MEMORY_MAX_CHARS);
      const id = memoryId(text);
      if (!text || have.has(id)) {
        continue;
      }
      have.add(id);
      lines.push(`- (${date}) [note] ${text}`);
    }
    if (lines.length === 0) {
      return 0;
    }
    const existing = (await this.read(this.memoryPath)) ?? MEMORY_HEADER;
    await this.desk.writeFile(
      this.memoryPath,
      `${existing.replace(/\n+$/, "")}\n${lines.join("\n")}\n`,
    );
    return lines.length;
  }

  /** The Bot's own brief, clamped to what a prompt may carry. */
  async instructions(): Promise<string> {
    return clamp(await this.read(this.instructionsPath), BOT_TEMPLATE_MAX.instructions) ?? "";
  }

  async setInstructions(markdown: string): Promise<void> {
    await this.desk.writeFile(this.instructionsPath, `${markdown.trimEnd()}\n`);
  }

  /**
   * The skills this Bot has: an index beside one markdown file each.
   *
   * Two files rather than one because of what each is for. The index is read
   * on every prompt, so it stays small; a body is read by the model with
   * `read_file` when it decides it wants the procedure, which is the same
   * shape a skill has in an Eve project and the reason the index carries the
   * "use when" line at all.
   */
  async skills(): Promise<BotTemplateSkill[]> {
    const index = jsonArray(await this.read(this.skillsPath));
    const out: BotTemplateSkill[] = [];
    for (const [i, entry] of index.slice(0, BOT_TEMPLATE_MAX.skills).entries()) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const o = entry as Record<string, unknown>;
      const id = templateSlug(o.id, BOT_TEMPLATE_MAX.skill_id, `skill-${i + 1}`);
      out.push({
        body: clamp(await this.read(this.skillBodyPath(id)), BOT_TEMPLATE_MAX.skill_body) ?? "",
        id,
        name: clamp(o.name, BOT_TEMPLATE_MAX.skill_name) ?? id,
        use_when: clamp(o.use_when, BOT_TEMPLATE_MAX.skill_use_when) ?? "",
      });
    }
    return out;
  }

  async setSkills(skills: readonly BotTemplateSkill[]): Promise<void> {
    for (const skill of skills) {
      await this.desk.writeFile(this.skillBodyPath(skill.id), `${skill.body.trimEnd()}\n`);
    }
    // The index is written last, so a run that dies part way through leaves
    // bodies nothing points at rather than an index pointing at nothing.
    await this.writeJson(
      this.skillsPath,
      skills.map((skill) => ({ id: skill.id, name: skill.name, use_when: skill.use_when })),
    );
  }

  /**
   * The routines declared for this Bot.
   *
   * Declared, and on a Bot made at runtime that is all they are: what fires a
   * routine is that Bot's own croner, compiled from `agent/schedules/*.ts` in
   * its project, and the template project has none. So a routine that arrives
   * with a template is recorded, shown, and honest about being paused rather
   * than quietly never running. `host/routines.ts` is the other half of that
   * story and reads the same shape out of the image.
   */
  async routines(): Promise<BotTemplateRoutine[]> {
    const out: BotTemplateRoutine[] = [];
    for (const [i, entry] of jsonArray(await this.read(this.routinesPath))
      .slice(0, BOT_TEMPLATE_MAX.routines)
      .entries()) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const o = entry as Record<string, unknown>;
      const cron = typeof o.cron === "string" ? o.cron.trim() : "";
      if (!validCron(cron)) {
        continue;
      }
      const id = templateSlug(o.id, BOT_TEMPLATE_MAX.routine_id, `routine-${i + 1}`);
      out.push({
        cron,
        id,
        prompt: clamp(o.prompt, BOT_TEMPLATE_MAX.routine_prompt) ?? "",
        title: clamp(o.title, BOT_TEMPLATE_MAX.routine_title) ?? id,
      });
    }
    return out;
  }

  async setRoutines(routines: readonly BotTemplateRoutine[]): Promise<void> {
    await this.writeJson(this.routinesPath, routines);
  }

  /**
   * The services this Bot expects to reach. A declaration, never a
   * credential: the plugin itself is installed from hello.expert by the human
   * whose accounts they are.
   */
  async plugins(): Promise<BotTemplatePlugin[]> {
    const out: BotTemplatePlugin[] = [];
    for (const entry of jsonArray(await this.read(this.pluginsPath)).slice(
      0,
      BOT_TEMPLATE_MAX.plugins,
    )) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const o = entry as Record<string, unknown>;
      const name = clamp(o.name, BOT_TEMPLATE_MAX.plugin_name);
      if (!name) {
        continue;
      }
      out.push({
        auth: o.auth === "oauth" ? "oauth" : "static",
        name,
        url: typeof o.url === "string" ? o.url : "",
      });
    }
    return out;
  }

  async setPlugins(plugins: readonly BotTemplatePlugin[]): Promise<void> {
    await this.writeJson(this.pluginsPath, plugins);
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await this.desk.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * The transcript as the hub left it, or `undefined` when it could not be
   * read at all. Oldest first, and `seq` is carried through untouched.
   *
   * The two answers are not the same and the caller must not conflate them.
   * The import marks itself done, so a box that will not answer, or a file
   * this hub may not read, has to come back as "unknown" and be tried again
   * next boot. Reading it as "no transcript" would retire the only copy of
   * the log unread, which is exactly the failure this whole move exists to
   * avoid.
   */
  async readTranscript(): Promise<Occurrence[] | undefined> {
    const raw = await this.read(this.transcriptPath);
    if (raw === undefined) {
      return undefined;
    }
    const out: Occurrence[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        out.push(JSON.parse(line) as Occurrence);
      } catch {
        // A torn last line is the normal shape of a crash mid-append. Skip it
        // rather than throwing away every bubble that came before.
      }
    }
    return out;
  }

  /** Missing file, unreadable box: both are "nothing there yet" to every caller here. */
  private async read(path: string): Promise<string | undefined> {
    try {
      return await this.desk.readFile(path);
    } catch {
      return undefined;
    }
  }
}

/**
 * The default profile with the project's seed folded over it, field by field.
 * Unknown shapes and colours, and strings over the caps, fall back to the
 * default rather than throwing: this runs at boot, and a Bot with a typo in
 * its shipped profile still has to come up.
 */
function seededProfile(id: string, seed?: Partial<BotProfile>): BotProfile {
  const fallback = defaultProfile(id);
  if (!seed) {
    return fallback;
  }
  return {
    avatar_color: oneOf(AVATAR_COLORS, seed.avatar_color) ?? fallback.avatar_color,
    avatar_shape: oneOf(AVATAR_SHAPES, seed.avatar_shape) ?? fallback.avatar_shape,
    description: clamp(seed.description, BOT_PROFILE_MAX.description) ?? fallback.description,
    id,
    name: clamp(seed.name, BOT_PROFILE_MAX.name) ?? fallback.name,
    title: clamp(seed.title, BOT_PROFILE_MAX.title) ?? fallback.title,
  };
}

function defaultProfile(id: string): BotProfile {
  const h = createHash("sha1").update(id).digest();
  return {
    avatar_color: AVATAR_COLORS[h[1]! % AVATAR_COLORS.length]!,
    avatar_shape: AVATAR_SHAPES[h[0]! % AVATAR_SHAPES.length]!,
    description: "",
    id,
    name: id,
    title: "",
  };
}

/** A JSON array from the box, or none. A file the model may rewrite never throws here. */
function jsonArray(raw: string | undefined): unknown[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A member of a closed set, or nothing. The read side never throws. */
function oneOf<T extends string>(allowed: readonly T[], v: unknown): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** Trimmed and truncated, or nothing when there is no string there. */
function clamp(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") {
    return undefined;
  }
  const trimmed = v.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The write side: a caller who asks for something outside the set is told so. */
function required<T extends string>(allowed: readonly T[], v: unknown, name: string): T {
  const picked = oneOf(allowed, v);
  if (!picked) {
    throw new ComputerError("VALIDATION", `${name} must be one of ${allowed.join(", ")}`);
  }
  return picked;
}

/**
 * One editable string. Over-long is refused rather than truncated: a human
 * typing into a form should be told, not quietly edited.
 */
function field(v: unknown, name: string, max: number, opts: { required?: boolean } = {}): string {
  if (v === undefined || v === null) {
    if (opts.required) {
      throw new ComputerError("VALIDATION", `${name} is required`);
    }
    return "";
  }
  if (typeof v !== "string") {
    throw new ComputerError("VALIDATION", `${name} must be a string`);
  }
  const trimmed = v.trim();
  if (trimmed.length > max) {
    throw new ComputerError("VALIDATION", `${name} must be at most ${max} characters`);
  }
  if (opts.required && trimmed.length === 0) {
    throw new ComputerError("VALIDATION", `${name} is required`);
  }
  return trimmed;
}
