import { BOT_TEMPLATE_MAX, parseBotTemplate } from "@computer/shared";
import type { BotTemplate } from "@computer/shared";

/**
 * Making a template generic: the difference between a copy of your Bot and a
 * Bot someone else can use.
 *
 * A working Bot is full of one person. Its brief names their product, its
 * skills name their repository and their spreadsheet, its memory is a list of
 * facts about them, and its description says "the human" but means one human
 * in particular. Published verbatim, that is both useless to a stranger (half
 * the procedures reference things they do not have) and a leak (their name,
 * their domain, the people they work with). So a shared template is rewritten
 * for a stranger before it is published, and this is where that happens.
 *
 * Two layers, and the split is deliberate because only one of them is a
 * promise:
 *
 * - **The scrub is deterministic and always runs.** Email addresses, phone
 *   numbers and home directories out of every string. It is narrow, it is
 *   testable, and it does not depend on a model being reachable or right.
 * - **The rewrite is a model's judgement, and it is judgement that is wanted**:
 *   which skills are about the job and which are about this person's product,
 *   and how to say the brief without naming anyone. A model is the only thing
 *   that can make that call, and it is also the thing that must never be the
 *   only safeguard. So the rewrite can only narrow (it picks which entries to
 *   keep, it does not invent), everything it returns goes back through
 *   `parseBotTemplate`, and the person publishing sees every section in full
 *   before the link exists.
 *
 * When the gateway is off or unreachable, the caller is told that the rewrite
 * did not run rather than handed the verbatim document as though it had. A
 * person who ticked "make it generic" and got their own name in the result is
 * the one failure this whole module exists to prevent.
 *
 * No SDK, one `fetch` to an OpenAI-shaped endpoint, the same shape and the
 * same environment variable as `service/auto-review.ts`.
 */

export interface GenericConfig {
  apiKey: string;
  model: string;
  endpoint: string;
  timeoutMs: number;
}

/** A whole document to rewrite, not one shell command: slower than a review. */
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_ENDPOINT = "https://ai-gateway.vercel.sh/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 30_000;

/** How much of a skill the model reads to decide whether it is about the job. */
const EXCERPT = 400;

/** Off is the absence of `AI_GATEWAY_API_KEY`, as Auto Review is off. */
export function genericConfig(env: NodeJS.ProcessEnv = process.env): GenericConfig | null {
  const apiKey = env.AI_GATEWAY_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  const timeout = Number(env.TEMPLATE_GENERIC_TIMEOUT_MS);
  return {
    apiKey,
    endpoint: env.AI_GATEWAY_URL?.trim() || DEFAULT_ENDPOINT,
    model: env.TEMPLATE_GENERIC_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

const SYSTEM_PROMPT = `You prepare one person's AI assistant to be shared with strangers as a template.

The assistant works on its owner's computer, so its setup is full of them: their name, their company, their products, their repositories, their colleagues, their domains, their timezone. Someone installing this template has none of those things. Your job is to hand them the same assistant with the person taken out of it.

Rewrite the identity fields:
- Say what the assistant does, never who it did it for. No names, no companies, no products, no domains, no repositories, no email addresses, no places.
- Keep the voice and the specificity of the job itself. "Drafts replies in the owner's voice and never sends them" is good. "Helps with stuff" is not: a vague template is a useless one.
- Keep any standing rule about what the assistant will not do. Those are the point.
- If a field is already generic, return it unchanged.

Then choose what travels. For each skill and routine you are given an id, a name, what it is for, and the start of its text:
- Keep it when it is a procedure any owner of this kind of assistant would want.
- Drop it when it only makes sense for this person: it names their product, their repository, their customers, their spreadsheet, their vendor, or a workflow nobody else has.
- When in doubt, keep it. The person publishing reads everything before it goes out.

Reply with only a JSON object:
{"name":"...","title":"...","description":"...","instructions":"...","keep_skills":["id",...],"keep_routines":["id",...],"dropped":"<one short sentence naming what you left out, or empty if nothing>"}`;

type FetchLike = typeof globalThis.fetch;

interface GenericResult {
  template: BotTemplate;
  /** What was left out, in one sentence, for the person publishing. */
  dropped: string;
}

/**
 * Rewrite a template for a stranger. Throws on every failure, so the caller
 * decides what a broken gateway means; it must never quietly answer with the
 * document it was asked to change.
 */
export async function generaliseTemplate(
  template: BotTemplate,
  cfg: GenericConfig,
  opts: { fetch?: FetchLike } = {},
): Promise<GenericResult> {
  const call = opts.fetch ?? globalThis.fetch;
  const res = await call(cfg.endpoint, {
    body: JSON.stringify({
      messages: [
        { content: SYSTEM_PROMPT, role: "system" },
        { content: describe(template), role: "user" },
      ],
      model: cfg.model,
      // The rewritten brief is the long part; the rest is a few ids.
      max_tokens: 3000,
      response_format: { type: "json_object" },
      temperature: 0,
    }),
    headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`template rewrite HTTP ${res.status}`);
  }
  const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("template rewrite returned no content");
  }
  return applyRewrite(template, parseRewrite(content));
}

/**
 * What the model sees: the identity fields whole, and enough of each skill and
 * routine to judge it. Bodies are excerpted rather than sent in full because
 * the decision being asked for is keep-or-drop, and twenty skill bodies is a
 * context window spent on text that comes back unchanged either way.
 */
function describe(t: BotTemplate): string {
  const lines = [
    `Name: ${t.name}`,
    `Label: ${t.title}`,
    `Description: ${t.description}`,
    "",
    "Instructions:",
    t.instructions || "(none)",
    "",
    "Skills:",
    ...(t.skills.length
      ? t.skills.map(
          (s) =>
            `- id=${s.id} name=${s.name} for=${s.use_when || "(unsaid)"}\n  ${excerpt(s.body)}`,
        )
      : ["(none)"]),
    "",
    "Routines:",
    ...(t.routines.length
      ? t.routines.map((r) => `- id=${r.id} title=${r.title}\n  ${excerpt(r.prompt)}`)
      : ["(none)"]),
  ];
  return lines.join("\n");
}

function excerpt(text: string): string {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT)}…` : flat || "(empty)";
}

interface Rewrite {
  name: string;
  title: string;
  description: string;
  instructions: string;
  keepSkills: Set<string>;
  keepRoutines: Set<string>;
  dropped: string;
}

/**
 * The model's reply. Tolerant of prose around the JSON, the way
 * `parseVerdict` is; strict about the shape, because a reply this cannot read
 * has to become "the rewrite did not run" rather than a half-applied one.
 */
export function parseRewrite(raw: string): Rewrite {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("template rewrite reply had no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error("template rewrite reply was not valid JSON");
  }
  const o = parsed as Record<string, unknown>;
  const name = str(o.name);
  if (!name) {
    throw new Error("template rewrite reply had no name");
  }
  return {
    description: str(o.description),
    dropped: str(o.dropped),
    instructions: str(o.instructions),
    keepRoutines: ids(o.keep_routines),
    keepSkills: ids(o.keep_skills),
    name,
    title: str(o.title),
  };
}

/**
 * The rewrite, applied to the document rather than trusted as one.
 *
 * The model returns prose and a list of ids. It does not return skills,
 * routines or memories, and this is what makes it unable to add anything: an
 * entry survives only if it was in the original and the model named it, and
 * the body that travels is the body that was already there, scrubbed. Memory
 * never travels in a generic template at all, because a fact a Bot kept about
 * the person it works for is the one thing that cannot be made generic.
 */
function applyRewrite(t: BotTemplate, rewrite: Rewrite): GenericResult {
  const template = parseBotTemplate({
    avatar_color: t.avatar_color,
    avatar_shape: t.avatar_shape,
    description: scrub(rewrite.description || t.description),
    instructions: scrub(rewrite.instructions || t.instructions),
    memories: [],
    name: scrub(rewrite.name),
    plugins: t.plugins,
    routines: t.routines
      .filter((r) => rewrite.keepRoutines.has(r.id))
      .map((r) => ({ ...r, prompt: scrub(r.prompt), title: scrub(r.title) })),
    skills: t.skills
      .filter((s) => rewrite.keepSkills.has(s.id))
      .map((s) => ({
        ...s,
        body: scrub(s.body),
        name: scrub(s.name),
        use_when: scrub(s.use_when),
      })),
    title: scrub(rewrite.title),
    version: t.version,
  });
  return { dropped: rewrite.dropped.slice(0, BOT_TEMPLATE_MAX.routine_title), template };
}

/**
 * The part that is a promise rather than a judgement.
 *
 * Three patterns, each narrow enough to be sure of: an email address, a run of
 * digits long enough to be a phone number, and a home directory on someone's
 * own machine. Deliberately not a name detector: a rule that guesses at names
 * removes words like "Bill" from a sentence about invoices and leaves the
 * owner believing the document was cleaned.
 */
export function scrub(text: string): string {
  return (
    text
      // The domain is spelled label-by-label rather than as one character
      // class, so the sentence's own full stop survives: eating the punctuation
      // after an address is a scrub that quietly corrupts the prose it cleans.
      .replaceAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu, "[removed]")
      .replaceAll(/\+?\d[\d\s().-]{7,}\d/gu, (match) =>
        (match.match(/\d/gu) ?? []).length >= 9 ? "[removed]" : match,
      )
      .replaceAll(/\/(?:Users|home)\/[A-Za-z0-9._-]+/gu, "~")
  );
}

/** Scrub every string in a template, for the path where no model ran. */
export function scrubTemplate(t: BotTemplate): BotTemplate {
  return parseBotTemplate({
    ...t,
    description: scrub(t.description),
    instructions: scrub(t.instructions),
    memories: t.memories.map(scrub),
    name: scrub(t.name),
    routines: t.routines.map((r) => ({ ...r, prompt: scrub(r.prompt), title: scrub(r.title) })),
    skills: t.skills.map((s) => ({
      ...s,
      body: scrub(s.body),
      name: scrub(s.name),
      use_when: scrub(s.use_when),
    })),
    title: scrub(t.title),
  });
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function ids(v: unknown): Set<string> {
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
}
