import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";

import { botTemplate } from "../db/bot-template";
import { db } from "./db";
import { parseTemplate } from "./bot-template";
import type { TemplateRecord } from "./bot-template";

/**
 * Shared Bot templates, in the same database as the invites.
 *
 * Two things are load-bearing here. **The document is parsed on the way out**,
 * not only on the way in, because the row was written from a computer whose
 * files a model can rewrite and it is read by a public page. And **a draft is
 * a row with no `published_at`**: the link exists as soon as the person
 * sharing has something to look at, and resolves for anyone else only once
 * they say so, which is the difference the card's Unpublished badge is
 * naming.
 */

/**
 * How many templates one account may hold.
 *
 * Not a product limit so much as a floor under the table: a template carries
 * up to twenty skill bodies, and an account that can make them without bound
 * can fill the control plane's database from a computer the control plane
 * does not own.
 */
const MAX_PER_OWNER = 100;

interface TemplateFailure {
  error: string;
  status: 400 | 403 | 404 | 409 | 502;
}

async function ensureTable(): Promise<void> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS bot_template (
      id TEXT PRIMARY KEY NOT NULL,
      owner_id TEXT NOT NULL,
      computer_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      template TEXT NOT NULL,
      installs INTEGER NOT NULL DEFAULT 0,
      published_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.run(sql`CREATE INDEX IF NOT EXISTS bot_template_owner_idx ON bot_template (owner_id)`);
}

/**
 * The link. Long enough that it cannot be walked, and it is the whole
 * credential the page has, so it is minted the way the invite tokens are.
 */
function newTemplateId(): string {
  return randomBytes(16).toString("base64url");
}

function asRecord(row: typeof botTemplate.$inferSelect): TemplateRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.template);
  } catch {
    return undefined;
  }
  const template = parseTemplate(parsed);
  if (!template) {
    return undefined;
  }
  return {
    botId: row.botId,
    computerId: row.computerId,
    createdAt: row.createdAt.getTime(),
    id: row.id,
    installs: row.installs,
    ownerId: row.ownerId,
    ...(row.publishedAt ? { publishedAt: row.publishedAt.getTime() } : {}),
    template,
    updatedAt: row.updatedAt.getTime(),
  };
}

/** Save a draft. The document is already clamped by the route that took it. */
export async function createTemplate(input: {
  botId: string;
  computerId: string;
  ownerId: string;
  template: unknown;
}): Promise<TemplateRecord | TemplateFailure> {
  const template = parseTemplate(input.template);
  if (!template) {
    return { error: "That Bot has nothing to share yet.", status: 400 };
  }
  const now = new Date();
  try {
    await ensureTable();
    const mine = await listTemplates(input.ownerId);
    if (mine.length >= MAX_PER_OWNER) {
      return { error: "You have too many templates. Delete one first.", status: 409 };
    }
    const id = newTemplateId();
    await db.insert(botTemplate).values({
      botId: input.botId,
      computerId: input.computerId,
      createdAt: now,
      id,
      installs: 0,
      ownerId: input.ownerId,
      template: JSON.stringify(template),
      updatedAt: now,
    });
    return {
      botId: input.botId,
      computerId: input.computerId,
      createdAt: now.getTime(),
      id,
      installs: 0,
      ownerId: input.ownerId,
      template,
      updatedAt: now.getTime(),
    };
  } catch {
    return { error: "Could not save the template.", status: 502 };
  }
}

export async function listTemplates(ownerId: string): Promise<TemplateRecord[]> {
  try {
    await ensureTable();
    const rows = await db
      .select()
      .from(botTemplate)
      .where(eq(botTemplate.ownerId, ownerId))
      .orderBy(desc(botTemplate.updatedAt))
      .limit(MAX_PER_OWNER);
    return rows.map(asRecord).filter((row): row is TemplateRecord => row !== undefined);
  } catch {
    return [];
  }
}

export async function templateById(id: string): Promise<TemplateRecord | undefined> {
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    await ensureTable();
    const [row] = await db.select().from(botTemplate).where(eq(botTemplate.id, trimmed)).limit(1);
    return row ? asRecord(row) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The template behind a link, for whoever opened it.
 *
 * A draft is not found rather than forbidden, and that is the point: an
 * unpublished template is one nobody has been told about, so the link should
 * not confirm that something is there. Its owner reads it through
 * `templateById` instead, which is the preview.
 */
export async function publishedTemplate(id: string): Promise<TemplateRecord | undefined> {
  const record = await templateById(id);
  return record?.publishedAt === undefined ? undefined : record;
}

/** Mint the link, or turn it off again. The row and its id survive both. */
export async function setPublished(
  id: string,
  ownerId: string,
  published: boolean,
  now = Date.now(),
): Promise<TemplateRecord | TemplateFailure> {
  const record = await templateById(id);
  if (!record) {
    return { error: "That template is not here.", status: 404 };
  }
  if (record.ownerId !== ownerId) {
    return { error: "That template is not yours.", status: 403 };
  }
  try {
    await db
      .update(botTemplate)
      .set({ publishedAt: published ? new Date(now) : null, updatedAt: new Date(now) })
      .where(eq(botTemplate.id, id));
  } catch {
    return { error: "Could not update the template.", status: 502 };
  }
  return {
    ...record,
    ...(published ? { publishedAt: now } : { publishedAt: undefined }),
    updatedAt: now,
  };
}

/**
 * Replace the document behind a link that is already out there.
 *
 * The id does not change, which is the whole reason this exists rather than
 * being a second create: a Bot that has been shared and then improved should
 * improve at the link people already have, and the alternative is a graveyard
 * of near-identical templates. What is already installed is untouched: a Bot
 * on someone else's computer is theirs from the moment it is made.
 */
export async function replaceTemplate(
  id: string,
  ownerId: string,
  template: unknown,
  now = Date.now(),
): Promise<TemplateRecord | TemplateFailure> {
  const parsed = parseTemplate(template);
  if (!parsed) {
    return { error: "That Bot has nothing to share yet.", status: 400 };
  }
  const record = await templateById(id);
  if (!record) {
    return { error: "That template is not here.", status: 404 };
  }
  if (record.ownerId !== ownerId) {
    return { error: "That template is not yours.", status: 403 };
  }
  try {
    await db
      .update(botTemplate)
      .set({ template: JSON.stringify(parsed), updatedAt: new Date(now) })
      .where(eq(botTemplate.id, id));
  } catch {
    return { error: "Could not update the template.", status: 502 };
  }
  return { ...record, template: parsed, updatedAt: now };
}

/** Deleting the template turns the link off, as the share dialog says it does. */
export async function deleteTemplate(
  id: string,
  ownerId: string,
): Promise<{ deleted: true } | TemplateFailure> {
  try {
    await ensureTable();
    const rows = await db
      .delete(botTemplate)
      .where(and(eq(botTemplate.id, id), eq(botTemplate.ownerId, ownerId)))
      .returning({ id: botTemplate.id });
    if (rows.length === 0) {
      return { error: "That template is not here.", status: 404 };
    }
  } catch {
    return { error: "Could not delete the template.", status: 502 };
  }
  return { deleted: true };
}

/**
 * One more Bot made from this template. Best effort on purpose: the Bot is
 * already on the person's computer by the time this runs, and a count that
 * did not increment must not read to them as an install that failed.
 */
export async function countInstall(id: string): Promise<void> {
  try {
    await db
      .update(botTemplate)
      .set({ installs: sql`${botTemplate.installs} + 1` })
      .where(eq(botTemplate.id, id));
  } catch {
    // The install stands either way.
  }
}
