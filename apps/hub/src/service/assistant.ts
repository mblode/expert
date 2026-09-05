import { ComputerError } from "@computer/shared";
import type { RuntimeConfiguration, RuntimeSkill } from "@computer/shared";
import { readTokenFile, writeTokenFile } from "./provision.ts";

interface Revision {
  bot: string;
  at: string;
  actor: string;
  config: RuntimeConfiguration;
}
const initial = (): RuntimeConfiguration => ({
  revision: 0,
  instructions: "",
  memory_set: false,
  memory: [],
  skills: [],
});

/** Approved runtime data lives with the hub, never in a model-writable source tree. */
export class AssistantState {
  private readonly revisions: Revision[];
  constructor(private readonly path?: string) {
    this.revisions = (path ? (readTokenFile(path, "assistant revisions") ?? []) : []).map((raw) => {
      const row = raw as Revision;
      if (
        !row ||
        typeof row.bot !== "string" ||
        typeof row.actor !== "string" ||
        typeof row.at !== "string" ||
        !row.config ||
        !Number.isSafeInteger(row.config.revision) ||
        row.config.revision < 1 ||
        typeof row.config.memory_set !== "boolean"
      )
        throw new Error("invalid assistant revision store");
      validate(row.config);
      return row;
    });
  }
  read(bot: string): RuntimeConfiguration {
    return structuredClone(this.revisions.findLast((row) => row.bot === bot)?.config ?? initial());
  }
  edit(bot: string, input: Record<string, unknown>, actor: string): RuntimeConfiguration {
    const current = this.read(bot);
    const allowed = new Set(["operation", "base_revision", "instructions", "memory", "skills"]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw new ComputerError("VALIDATION", "unknown configuration field");
    if (input.operation === "read") return current;
    if (input.base_revision !== current.revision)
      throw new ComputerError(
        "CONFLICT",
        "configuration changed; read its current revision before editing",
      );
    let next: RuntimeConfiguration;
    if (input.operation === "undo") {
      const history = this.revisions.filter((row) => row.bot === bot);
      if (!history.length)
        throw new ComputerError("CONFLICT", "there is no configuration change to undo");
      next = structuredClone(history.at(-2)?.config ?? initial());
    } else if (input.operation === "replace") {
      if (["instructions", "memory", "skills"].every((key) => input[key] === undefined))
        throw new ComputerError("VALIDATION", "a replacement needs at least one field");
      next = {
        ...current,
        ...(input.instructions === undefined ? {} : { instructions: input.instructions as string }),
        ...(input.memory === undefined
          ? {}
          : { memory: input.memory as string[], memory_set: true }),
        ...(input.skills === undefined ? {} : { skills: input.skills as RuntimeSkill[] }),
      };
    } else throw new ComputerError("VALIDATION", "operation must be read, replace or undo");
    next.revision = current.revision + 1;
    validate(next);
    next = structuredClone(next);
    const rows = [...this.revisions, { bot, actor, at: new Date().toISOString(), config: next }];
    if (this.path) writeTokenFile(this.path, rows);
    this.revisions.push(rows.at(-1)!);
    return structuredClone(next);
  }
}

function validate(config: RuntimeConfiguration): void {
  if (
    typeof config.instructions !== "string" ||
    config.instructions.length > 10_000 ||
    !Array.isArray(config.memory) ||
    config.memory.length > 50 ||
    config.memory.some((line) => typeof line !== "string" || !line.trim() || line.length > 500) ||
    !Array.isArray(config.skills) ||
    config.skills.length > 20
  )
    throw new ComputerError("VALIDATION", "invalid instructions, memory or skill limits");
  if (
    config.skills.reduce(
      (size, skill) => size + (typeof skill?.markdown === "string" ? skill.markdown.length : 0),
      0,
    ) > 16_000
  )
    throw new ComputerError("VALIDATION", "procedures exceed the 16000 character combined limit");
  const ids = new Set<string>();
  for (const skill of config.skills) {
    if (
      !skill ||
      typeof skill.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,47}$/.test(skill.id) ||
      ids.has(skill.id) ||
      typeof skill.description !== "string" ||
      !skill.description.trim() ||
      skill.description.length > 300 ||
      typeof skill.markdown !== "string" ||
      !skill.markdown.trim() ||
      skill.markdown.length > 16_000 ||
      Object.keys(skill).some((key) => !["id", "description", "markdown"].includes(key))
    )
      throw new ComputerError("VALIDATION", "invalid skill definition");
    ids.add(skill.id);
  }
}
