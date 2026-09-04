import { generateObject } from "ai";
import { defineChannel, POST } from "eve/channels";
import { createUnauthorizedResponse } from "eve/channels/auth";
import { z } from "zod";
import { EVE_HUB_SECRET_HEADER, eveHubSecretFromEnv, eveHubSecretMatches } from "../auth.ts";

/**
 * Making this Bot's setup generic, done by this Bot's own model.
 *
 * A template read straight off a working Bot is one person's: its brief names
 * their product, its skills name their repository and their board, its memory
 * is a list of facts about them. Published verbatim that is useless to
 * whoever installs it and a leak besides. Taking the person out of it is not a
 * search-and-replace job, which is the whole reason it lives here: knowing
 * that "the Done Bear board" is this owner's product while "the week view" is
 * anybody's calendar is a judgement, and a regex that tried would either miss
 * the first or mangle the second and leave the owner believing the document
 * was cleaned.
 *
 * So the hub POSTs the document here, to the Bot whose setup it is, and this
 * runs the same gateway model the Bot itself runs (`agent/agent.ts`).
 *
 * A route rather than a session, deliberately. `from(...).send(...)` would
 * start a turn: durable, asynchronous, and holding the five tools, so a
 * document being rewritten would be a document that could act. This is a pure
 * transformation with a schema on the way out, so it answers in one request
 * and can touch nothing.
 *
 * The door is the hub's own loopback secret, the same one the webhook channel
 * checks. Nothing outside the box reaches it, and the hub only calls it for
 * an owner at a seat who asked to share the Bot.
 */

/**
 * What comes back.
 *
 * Entries keep their ids so the hub can throw away anything it did not send:
 * this is the Bot's own model reading its own files, and the hub still treats
 * the answer as a proposal. Dropping an entry is how the model says a skill
 * is only about this person; it cannot add one.
 */
const REWRITE = z.object({
  description: z.string(),
  dropped: z.string(),
  instructions: z.string(),
  name: z.string(),
  routines: z.array(z.object({ id: z.string(), prompt: z.string(), title: z.string() })),
  skills: z.array(
    z.object({
      body: z.string(),
      id: z.string(),
      name: z.string(),
      use_when: z.string(),
    }),
  ),
  title: z.string(),
});

/** The document as the hub hands it over. Clamped there, and again on the way back. */
interface TemplateIn {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  instructions?: unknown;
  skills?: { id?: unknown; name?: unknown; use_when?: unknown; body?: unknown }[];
  routines?: { id?: unknown; title?: unknown; prompt?: unknown }[];
}

const SYSTEM = `You are preparing your own setup to be shared with a stranger as a template.

Everything you are given is yours: your name, your label, your description, the brief you work from, your skills and your routines. It is full of the person you work for. Someone installing this template has none of what you have: not their product, not their repository, not their colleagues, not their calendar. Your job is to hand them the same assistant with the person taken out of it.

Rewrite every field:
- Say what the work is, never who it was for. No personal names, no company or product names, no repository or file names that belong to this owner, no domains, no email addresses, no phone numbers, no home directories, no places, no clients, no colleagues.
- Keep the specificity of the job. "Draft the reply in the owner's voice and never send it" is good; "help with email" is useless. A vague template is not worth installing.
- Keep every standing rule about what you will not do. Those are the point.
- Where a detail was the owner's, replace it with the role it played: "the owner", "their product", "the repository", "their calendar". Do not invent a different specific.
- A field that is already generic comes back unchanged.

Then decide what travels, by returning it or leaving it out:
- Return a skill or a routine when it is a procedure any owner of an assistant like you would want.
- Leave it out when it only makes sense for this person: it is about their product, their customers, their vendor, their board, or a workflow nobody else has.
- When in doubt, return it rewritten. A person reads all of this before it is published.
- Never return an id you were not given, and never invent a skill or a routine.

\`dropped\` is one short sentence for the person publishing, naming what you left out and why. Empty if you left nothing out.`;

/** Everything the model needs to rewrite one Bot, and nothing about the box. */
function describe(t: TemplateIn): string {
  const skills = (t.skills ?? []).map(
    (s) =>
      `- id: ${str(s.id)}\n  name: ${str(s.name)}\n  use when: ${str(s.use_when)}\n  body:\n${indent(str(s.body))}`,
  );
  const routines = (t.routines ?? []).map(
    (r) => `- id: ${str(r.id)}\n  title: ${str(r.title)}\n  prompt:\n${indent(str(r.prompt))}`,
  );
  return [
    `Name: ${str(t.name)}`,
    `Label: ${str(t.title)}`,
    `Description: ${str(t.description)}`,
    "",
    "Brief:",
    str(t.instructions) || "(none)",
    "",
    "Skills:",
    ...(skills.length ? skills : ["(none)"]),
    "",
    "Routines:",
    ...(routines.length ? routines : ["(none)"]),
  ].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * `model` is the string id the Bot's own `agent.ts` uses, so a template is
 * rewritten by the model that wrote the setup rather than by a second one
 * chosen here. A bare `provider/model` resolves through the Vercel AI Gateway
 * on `AI_GATEWAY_API_KEY`, which is how every model id in this repo is spelled.
 */
interface TemplateChannelOptions {
  model: string;
}

export function templateChannel(opts: TemplateChannelOptions) {
  return defineChannel({
    routes: [
      POST("/eve/v1/template/generic", async (req) => {
        const secret = eveHubSecretFromEnv();
        if (!secret) {
          return Response.json({ error: "COMPUTER_EVE_SECRET is not set" }, { status: 503 });
        }
        if (!eveHubSecretMatches(req.headers.get(EVE_HUB_SECRET_HEADER), secret)) {
          return createUnauthorizedResponse({ message: "bad or missing hub secret" });
        }
        let body: { template?: TemplateIn };
        try {
          body = (await req.json()) as { template?: TemplateIn };
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        if (!body.template || typeof body.template !== "object") {
          return Response.json({ error: "template is required" }, { status: 400 });
        }
        try {
          const { object } = await generateObject({
            model: opts.model,
            prompt: describe(body.template),
            schema: REWRITE,
            system: SYSTEM,
            temperature: 0,
          });
          return Response.json(object);
        } catch (error) {
          // The hub turns this into "the rewrite did not run" and says so to
          // the person, who is standing in front of the sheet. Never a
          // half-rewritten document: it would read as clean and not be.
          return Response.json(
            { error: error instanceof Error ? error.message : "rewrite failed" },
            { status: 502 },
          );
        }
      }),
    ],
  });
}
