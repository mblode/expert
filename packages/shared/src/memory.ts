import { createHash } from "node:crypto";

type MemoryKind = "note" | "episode";

interface MemoryEntry {
  /** sha1 of the normalised content: the same fact written twice is one entry. */
  id: string;
  date: string;
  kind: MemoryKind;
  text: string;
}

/** One fact per line. Grok caps entries around here; longer lines are truncated, not dropped. */
export const MEMORY_MAX_CHARS = 500;

/** How much memory rides along in the system prompt. The box is a pet, not a RAG index. */
export const MEMORY_IN_PROMPT = 50;

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
