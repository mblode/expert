import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { BOT_TEMPLATE_MAX, parseRoutines, templateSlug } from "@computer/shared";
import type { BotTemplatePlugin, BotTemplateRoutine, BotTemplateSkill } from "@computer/shared";
import type { TemplateSource, TemplateSourceReader } from "../service/templates.ts";

/**
 * What a Bot's Eve project ships, for the half of a template that is in git.
 *
 * A Bot that came with the build keeps its brief in `agent/instructions.md`,
 * its procedures in `agent/skills/<name>/SKILL.md`, its schedule in
 * `agent/routines.json` beside `agent/schedules/*.ts`, and the services it
 * reaches in `agent/connections/*.ts`. None of that is on the volume, so
 * without this file the eight Bots this computer ships would export as a name
 * and a paragraph while a Bot made in the browser exported everything.
 *
 * It reads the image's own filesystem, which is why it lives in `host/` and
 * is handed to the service as a function: same shape and same reason as
 * `host/bot-seed.ts`. Every read is best effort. A project with no skills
 * directory, an unreadable schedule or a connection file this cannot parse
 * exports one section short rather than failing the export.
 */
interface TemplateIo {
  read: (path: string) => string;
  list: (path: string) => string[];
}

const NODE_IO: TemplateIo = {
  list: (path) => readdirSync(path),
  read: (path) => readFileSync(path, "utf-8"),
};

/**
 * A reader over one Eve bots root. Nested `bots/<id>/agent`, or `agent` at the
 * root for a standalone project mounted as `main`: the two layouts
 * `planEveLaunches` and `profileSeeds` already accept.
 */
export function templateSources(botsRoot: string, io: TemplateIo = NODE_IO): TemplateSourceReader {
  return (botId) => {
    const dirs = [join(botsRoot, botId, "agent")];
    if (botId === "main") {
      dirs.push(join(botsRoot, "agent"));
    }
    for (const dir of dirs) {
      const source = readProject(dir, io);
      if (source) {
        return source;
      }
    }
    return undefined;
  };
}

/** A project is there when at least one of the four things a template carries is. */
function readProject(agentDir: string, io: TemplateIo): TemplateSource | undefined {
  const instructions = tryRead(io, join(agentDir, "instructions.md"));
  const skills = readSkills(agentDir, io);
  const routines = readRoutines(agentDir, io);
  const plugins = readPlugins(agentDir, io);
  if (!(instructions || skills.length || routines.length || plugins.length)) {
    return undefined;
  }
  return { ...(instructions ? { instructions } : {}), plugins, routines, skills };
}

function readSkills(agentDir: string, io: TemplateIo): BotTemplateSkill[] {
  const root = join(agentDir, "skills");
  const out: BotTemplateSkill[] = [];
  for (const entry of tryList(io, root).slice(0, BOT_TEMPLATE_MAX.skills)) {
    const raw = tryRead(io, join(root, entry, "SKILL.md"));
    if (!raw) {
      continue;
    }
    const { body, description } = splitFrontmatter(raw);
    out.push({
      body,
      id: templateSlug(entry, BOT_TEMPLATE_MAX.skill_id, "skill"),
      // The heading is what the skill calls itself; the directory is what the
      // project calls it, and only one of the two is written for a reader.
      name: heading(body) ?? entry,
      use_when: triggerLine(description),
    });
  }
  return out;
}

/**
 * The routines a Bot declares, with the prompt each one runs.
 *
 * `routines.json` is the data half of the two-file declaration
 * (`host/routines.ts`), so the id and the cron come from there and are already
 * pinned to the schedules by `routines.test.ts`. The prompt lives in the
 * schedule module as a template literal, and it is lifted out with a regex
 * rather than by importing the module: this runs in the hub, the module is
 * built for a different process, and a routine whose prompt could not be read
 * still travels as a schedule with a name.
 */
function readRoutines(agentDir: string, io: TemplateIo): BotTemplateRoutine[] {
  const raw = tryRead(io, join(agentDir, "routines.json"));
  if (!raw) {
    return [];
  }
  return parseRoutines(raw)
    .slice(0, BOT_TEMPLATE_MAX.routines)
    .map((routine) => ({
      cron: routine.cron,
      id: templateSlug(routine.id, BOT_TEMPLATE_MAX.routine_id, "routine"),
      prompt: scheduleMarkdown(tryRead(io, join(agentDir, "schedules", `${routine.id}.ts`))),
      title: titleCase(routine.id),
    }));
}

/**
 * The services this project reaches, as declarations.
 *
 * A file that only re-exports a shared connection is skipped, and so is one
 * with no literal address: both are wiring rather than a service a person
 * installing this template would have to connect. Nothing here reads a
 * credential, and there is none to read: a static key is an env var name in
 * the source and the value is a Fly secret.
 */
function readPlugins(agentDir: string, io: TemplateIo): BotTemplatePlugin[] {
  const root = join(agentDir, "connections");
  const out: BotTemplatePlugin[] = [];
  for (const entry of tryList(io, root).slice(0, BOT_TEMPLATE_MAX.plugins)) {
    if (!entry.endsWith(".ts")) {
      continue;
    }
    const source = tryRead(io, join(root, entry));
    const url = /url:\s*"([^"]+)"/u.exec(source ?? "")?.[1];
    if (!url) {
      continue;
    }
    out.push({
      auth: source?.includes("@vercel/connect") ? "oauth" : "static",
      name: basename(entry, ".ts"),
      url,
    });
  }
  return out;
}

/** `description:` out of the YAML header, and the markdown after it. */
function splitFrontmatter(raw: string): { body: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(raw);
  if (!match) {
    return { body: raw.trim(), description: "" };
  }
  const description = /description:\s*"?([\s\S]*?)"?\s*$/mu.exec(match[1] ?? "")?.[1] ?? "";
  return { body: raw.slice(match[0].length).trim(), description: description.trim() };
}

/**
 * The trigger, which is the half of a description a person reads to decide
 * whether they want the skill. Skills here write it as a "Use when ..."
 * sentence at the end of the description; one that does not gets the whole
 * description, which is never worse than nothing.
 */
function triggerLine(description: string): string {
  const match = /\bUse when\b[\s\S]*$/u.exec(description);
  return (match?.[0] ?? description).trim().slice(0, BOT_TEMPLATE_MAX.skill_use_when);
}

function heading(body: string): string | undefined {
  return /^#\s+(.+)$/mu.exec(body)?.[1]?.trim().slice(0, BOT_TEMPLATE_MAX.skill_name);
}

/**
 * The `markdown:` template literal of a `defineSchedule`. Escapes are undone
 * because they are TypeScript's, not the prompt's: a schedule that writes a
 * backtick or a dollar-brace means the character, not the syntax.
 */
function scheduleMarkdown(source: string | undefined): string {
  const match = /markdown:\s*`([\s\S]*?)`\s*,?\s*\n\}\)/u.exec(source ?? "");
  if (!match?.[1]) {
    return "";
  }
  return match[1]
    .replaceAll("\\`", "`")
    .replaceAll("\\${", "${")
    .trim()
    .slice(0, BOT_TEMPLATE_MAX.routine_prompt);
}

function titleCase(id: string): string {
  const words = id.replaceAll("-", " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}

function tryRead(io: TemplateIo, path: string): string | undefined {
  try {
    return io.read(path);
  } catch {
    return undefined;
  }
}

function tryList(io: TemplateIo, path: string): string[] {
  try {
    return io.list(path);
  } catch {
    return [];
  }
}
