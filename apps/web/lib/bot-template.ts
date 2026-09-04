/**
 * A Bot template, on the control plane.
 *
 * The hub can export a Bot's setup and apply one, but it cannot hold a link:
 * a computer is one account's, and the whole point of sharing a Bot is that
 * the person receiving it is on a different one. So the document is copied
 * here, to hello.expert, which is the only thing both accounts can see, and
 * the link is a row in the same database the invites live in.
 *
 * The clamp below is the reason this file exists rather than the row being
 * served as it was stored. A stored template was authored on someone's
 * computer, by a model that can rewrite its own files, and it ends up in two
 * places that matter: a public page, and the system prompt of a Bot on the
 * computer of whoever installed it. It is mirrored from `parseBotTemplate` in
 * `packages/shared` (this app does not depend on that package, the way it
 * does not for the avatar palette), and the hub clamps again on the way in:
 * neither end trusts the other with a document neither of them wrote.
 */

import { AVATAR_COLORS, AVATAR_SHAPES } from "./seat";
import type {
  AvatarColor,
  AvatarShape,
  BotTemplate,
  BotTemplatePlugin,
  BotTemplateRoutine,
  BotTemplateSkill,
} from "./seat";

const BOT_TEMPLATE_VERSION = 1;

/** Mirrors BOT_TEMPLATE_MAX and BOT_PROFILE_MAX in `packages/shared`. */
const TEMPLATE_MAX = {
  description: 500,
  instructions: 8000,
  memories: 100,
  memory: 500,
  name: 48,
  plugin_name: 80,
  plugins: 20,
  routine_id: 48,
  routine_prompt: 4000,
  routine_title: 120,
  routines: 20,
  skill_body: 8000,
  skill_id: 48,
  skill_name: 64,
  skill_use_when: 300,
  skills: 20,
  title: 64,
} as const;

/** What a stored row says about itself, beside the document. */
export interface TemplateRecord {
  id: string;
  botId: string;
  computerId: string;
  createdAt: number;
  installs: number;
  ownerId: string;
  publishedAt?: number;
  template: BotTemplate;
  updatedAt: number;
}

/** The public view of a template: everything the page shows, and nothing else. */
export interface TemplateView {
  id: string;
  installs: number;
  published: boolean;
  template: BotTemplate;
  /** The counts under each row on the card, worked out once. */
  counts: { memories: number; plugins: number; routines: number; skills: number };
}

export function templateView(record: TemplateRecord): TemplateView {
  const t = record.template;
  return {
    counts: {
      memories: t.memories.length,
      plugins: t.plugins.length,
      routines: t.routines.length,
      skills: t.skills.length,
    },
    id: record.id,
    installs: record.installs,
    published: record.publishedAt !== undefined,
    template: t,
  };
}

/**
 * Read a template out of something that arrived over HTTP or came back out of
 * the database, clamped. Undefined when there is nothing usable there: unlike
 * the hub, which owes a caller a reason, this end has a row to render or not.
 */
export function parseTemplate(value: unknown): BotTemplate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const o = value as Record<string, unknown>;
  const name = text(o.name, TEMPLATE_MAX.name);
  if (!name) {
    return undefined;
  }
  const mark = defaultMark(name);
  return {
    avatar_color: pick(AVATAR_COLORS, o.avatar_color) ?? mark.color,
    avatar_shape: pick(AVATAR_SHAPES, o.avatar_shape) ?? mark.shape,
    description: text(o.description, TEMPLATE_MAX.description),
    instructions: text(o.instructions, TEMPLATE_MAX.instructions),
    memories: array(o.memories, TEMPLATE_MAX.memories)
      .map((entry) => text(entry, TEMPLATE_MAX.memory))
      .filter(Boolean),
    name,
    plugins: array(o.plugins, TEMPLATE_MAX.plugins)
      .map(parsePlugin)
      .filter((entry): entry is BotTemplatePlugin => entry !== undefined),
    routines: dedupe(
      array(o.routines, TEMPLATE_MAX.routines)
        .map(parseRoutine)
        .filter((entry): entry is BotTemplateRoutine => entry !== undefined),
    ),
    skills: dedupe(
      array(o.skills, TEMPLATE_MAX.skills)
        .map(parseSkill)
        .filter((entry): entry is BotTemplateSkill => entry !== undefined),
    ),
    title: text(o.title, TEMPLATE_MAX.title),
    version: BOT_TEMPLATE_VERSION,
  };
}

/**
 * What the person sharing chose to include, applied to what their computer
 * exported. The sections are ticked in front of them, which is where a
 * decision about publishing someone's memory belongs.
 */
export interface TemplateSections {
  instructions: boolean;
  memories: boolean;
  plugins: boolean;
  routines: boolean;
  skills: boolean;
}

/**
 * Which sections a published template actually carries.
 *
 * The stored document is the record of what was shared, so this is how the
 * sheet reopens on the choices that were made rather than on its own defaults.
 * Without it, "Update from this Bot" re-published a Bot with whatever the
 * switches happened to say: memories that were deliberately included silently
 * dropped, skills that were deliberately left out silently restored.
 */
export function sectionsOf(template: BotTemplate): TemplateSections {
  return {
    instructions: template.instructions.length > 0,
    memories: template.memories.length > 0,
    plugins: template.plugins.length > 0,
    routines: template.routines.length > 0,
    skills: template.skills.length > 0,
  };
}

export function pickSections(template: BotTemplate, sections: TemplateSections): BotTemplate {
  return {
    ...template,
    instructions: sections.instructions ? template.instructions : "",
    memories: sections.memories ? template.memories : [],
    plugins: sections.plugins ? template.plugins : [],
    routines: sections.routines ? template.routines : [],
    skills: sections.skills ? template.skills : [],
  };
}

/**
 * A cron this codebase can evaluate, in the words a person reads.
 *
 * Deliberately partial: it names the shapes the schedules here actually use
 * and falls back to the expression itself for anything else, because a wrong
 * English sentence about when a routine runs is worse than the cron.
 */
export function cronLabel(cron: string): string {
  const parts = cron.trim().split(/\s+/u);
  if (parts.length !== 5) {
    return cron;
  }
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (!(/^\d+$/u.test(minute) && /^\d+$/u.test(hour) && dom === "*" && month === "*")) {
    return cron;
  }
  const at = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} UTC`;
  if (dow === "*") {
    return `Every day at ${at}`;
  }
  const days = dayNames(dow);
  return days ? `${days} at ${at}` : cron;
}

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayNames(field: string): string | undefined {
  const range = /^(\d)-(\d)$/u.exec(field);
  const numbers = range
    ? Array.from(
        { length: Number(range[2]) - Number(range[1]) + 1 },
        (_, i) => Number(range[1]) + i,
      )
    : field.split(",").map(Number);
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) {
    return undefined;
  }
  return numbers.map((n) => DAY[n]).join(", ");
}

function parseSkill(value: unknown, index: number): BotTemplateSkill | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const o = value as Record<string, unknown>;
  const name = text(o.name, TEMPLATE_MAX.skill_name);
  const body = text(o.body, TEMPLATE_MAX.skill_body);
  if (!(name || body)) {
    return undefined;
  }
  return {
    body,
    id: slug(o.id ?? name, TEMPLATE_MAX.skill_id, `skill-${index + 1}`),
    name: name || "Skill",
    use_when: text(o.use_when, TEMPLATE_MAX.skill_use_when),
  };
}

function parseRoutine(value: unknown, index: number): BotTemplateRoutine | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const o = value as Record<string, unknown>;
  const cron = typeof o.cron === "string" ? o.cron.trim() : "";
  if (!validCron(cron)) {
    return undefined;
  }
  const title = text(o.title, TEMPLATE_MAX.routine_title);
  return {
    cron,
    id: slug(o.id ?? title, TEMPLATE_MAX.routine_id, `routine-${index + 1}`),
    prompt: text(o.prompt, TEMPLATE_MAX.routine_prompt),
    title: title || "Routine",
  };
}

function parsePlugin(value: unknown): BotTemplatePlugin | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const o = value as Record<string, unknown>;
  const name = text(o.name, TEMPLATE_MAX.plugin_name);
  if (!name) {
    return undefined;
  }
  return { auth: o.auth === "oauth" ? "oauth" : "static", name, url: httpUrl(o.url) };
}

/** Five fields in range, the same subset `cronMatches` understands. */
function validCron(cron: string): boolean {
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) {
    return false;
  }
  return fields.every((field, i) => {
    if (!/^(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?)(,(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?))*$/u.test(field)) {
      return false;
    }
    const [min, max] = bounds[i]!;
    return field.split(",").every((part) => {
      const [range, step] = part.split("/");
      if (step !== undefined && !(Number(step) >= 1)) {
        return false;
      }
      if (range === "*") {
        return true;
      }
      const [fromRaw, toRaw] = (range ?? "").split("-");
      const from = Number(fromRaw);
      const to = toRaw === undefined ? from : Number(toRaw);
      return from >= min && from <= max && to >= from && to <= max;
    });
  });
}

/** Rendered as a link, so the scheme is a closed set rather than what it says. */
function httpUrl(value: unknown): string {
  try {
    const url = new URL(typeof value === "string" ? value : "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function slug(raw: unknown, max: number, fallback: string): string {
  const out = (typeof raw === "string" ? raw : "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, max)
    .replaceAll(/-+$/gu, "");
  return out || fallback;
}

function dedupe<T extends { id: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
}

function array(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

/** Control characters go: text from a document must not fake structure. */
function text(value: unknown, max: number): string {
  if (typeof value !== "string") {
    return "";
  }
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // Tab and newline survive; everything else below space would let a
    // document fake structure in the page or the prompt it lands in.
    if (code === 9 || code === 10 || (code >= 0x20 && code !== 0x7f)) {
      out += ch;
    }
  }
  return out.trim().slice(0, max);
}

function pick<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function defaultMark(name: string): { color: AvatarColor; shape: AvatarShape } {
  let sum = 0;
  for (const ch of name) {
    sum = (sum * 31 + (ch.codePointAt(0) ?? 0)) % 0xff_ff_ff;
  }
  return {
    color: AVATAR_COLORS[sum % AVATAR_COLORS.length]!,
    shape: AVATAR_SHAPES[Math.floor(sum / 16) % AVATAR_SHAPES.length]!,
  };
}
