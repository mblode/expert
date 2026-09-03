import { createHash } from "node:crypto";
import type { MessageBody } from "@computer/shared";
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

/** Grok's profile fields, snake_cased like the rest of our on-box JSON. */
interface BotProfile {
  id: string;
  name: string;
  description: string;
  title: string;
  avatar_shape: string;
  avatar_color: string;
}

type MemoryKind = "note" | "episode";

interface MemoryEntry {
  /** sha1 of the normalised content: the same fact written twice is one entry. */
  id: string;
  date: string;
  kind: MemoryKind;
  text: string;
}

const AVATAR_SHAPES = ["circle", "square", "hexagon", "diamond"] as const;
const AVATAR_COLORS = ["#e5484d", "#f76b15", "#f5d90a", "#46a758", "#0091ff", "#8e4ec6"] as const;

/** One fact per line. Grok caps entries around here; longer lines are truncated, not dropped. */
const MEMORY_MAX_CHARS = 500;

/** How much memory rides along in the system prompt. The box is a pet, not a RAG index. */
const MEMORY_IN_PROMPT = 50;

/** `- (2026-09-01) [note] the fact`. The kind prefix is optional and defaults to note. */
const MEMORY_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(?:\[(note|episode)\]\s*)?(\S.*)$/;

/**
 * Identity of a fact is its content, so an agent that appends something it
 * already knows does not get told twice. Normalise the way a human would
 * consider two lines "the same": case and whitespace only.
 */
export function memoryId(text: string): string {
  const normalised = text.toLowerCase().replaceAll(/\s+/g, " ").trim();
  return createHash("sha1").update(normalised).digest("hex").slice(0, 16);
}

/**
 * Read side of the memory contract. The agent writes these lines itself with
 * `write_file`, it already has the tool, so there is no second door, and
 * this enforces the shape on the way back in: anything that is not a fact
 * line (the header, a stray note) is ignored, over-long lines are truncated,
 * and a repeated fact appears once.
 */
export function parseMemory(markdown: string): MemoryEntry[] {
  const seen = new Set<string>();
  const out: MemoryEntry[] = [];
  for (const line of markdown.split("\n")) {
    const m = MEMORY_LINE.exec(line.trim());
    if (!m) {
      continue;
    }
    const text = m[3]!.trim().slice(0, MEMORY_MAX_CHARS);
    const id = memoryId(text);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push({ date: m[1]!, id, kind: (m[2] as MemoryKind) ?? "note", text });
  }
  return out;
}

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
   */
  async init(): Promise<void> {
    if (!(await this.read(this.profilePath))) {
      await this.desk.writeFile(
        this.profilePath,
        `${JSON.stringify(defaultProfile(this.botId), null, 2)}\n`,
      );
    }
    if (!(await this.read(this.memoryPath))) {
      await this.desk.writeFile(this.memoryPath, MEMORY_HEADER);
    }
  }

  async profile(): Promise<BotProfile> {
    const raw = await this.read(this.profilePath);
    const fallback = defaultProfile(this.botId);
    if (!raw) {
      return fallback;
    }
    try {
      // The agent can edit this file, so treat every field as untrusted and
      // fall back per-field: a hand-broken profile must not break the prompt.
      const o = JSON.parse(raw) as Partial<BotProfile>;
      return {
        avatar_color: str(o.avatar_color) ?? fallback.avatar_color,
        avatar_shape: str(o.avatar_shape) ?? fallback.avatar_shape,
        description: str(o.description) ?? fallback.description,
        id: this.botId,
        name: str(o.name) ?? fallback.name,
        title: str(o.title) ?? fallback.title,
      };
    } catch {
      return fallback;
    }
  }

  async memory(): Promise<MemoryEntry[]> {
    return parseMemory((await this.read(this.memoryPath)) ?? "");
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

  /**
   * Who this Bot is, for the system prompt. A fresh Bot with a default
   * profile and no memory still gets its directory, because that path is how
   * the agent reaches the memory file to write to it.
   */
  async prompt(): Promise<string> {
    const p = await this.profile();
    const lines = [`You are ${p.name}${p.title ? `, ${p.title}` : ""}.`];
    if (p.description) {
      lines.push(p.description);
    }
    lines.push(
      `Your own files are in ${this.dir}. ${this.memoryPath} is your memory, read it, and write_file a new "- (date) [note] fact" line when something is worth keeping.`,
    );
    const entries = await this.memory();
    if (entries.length) {
      lines.push("What you remember:");
      for (const e of entries.slice(-MEMORY_IN_PROMPT)) {
        lines.push(`- (${e.date}) [${e.kind}] ${e.text}`);
      }
    }
    return lines.join("\n");
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

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
