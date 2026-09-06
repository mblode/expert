import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tenantDataDir } from "./chat-archive-source.ts";

/**
 * The community's own story: a curated timeline of in-group moments (who
 * joined, the meetups, the debates, running gags) plus short reference prose
 * on its origin and themes. Read by the `group-history` tool.
 *
 * A file on the tenant's volume (`group-history.json` under `tenantDataDir()`),
 * like the archive and the roster: it is lore about real people, this
 * repository is public, and a computer that is not that community has no
 * history to tell. Deliberately not a feed of external product facts: no model
 * prices, benchmark numbers or context-window specs belong here. Those are
 * current claims the Bot confirms with `web_search`, never recites.
 */

export interface HistoryEntry {
  /** ISO date, or coarse range ("2025-04 to 2025-06"). */
  date: string;
  /** One line, framed as what the group did or discussed. */
  summary: string;
  /** Members involved, for filtering by person. */
  people?: string[];
}

export interface GroupHistory {
  /** Short reference prose by topic: `origin`, `themes`, `meetups`, and so on. */
  context: Record<string, string>;
  timeline: HistoryEntry[];
}

export const GROUP_HISTORY_FILE = "group-history.json";

const EMPTY: GroupHistory = { context: {}, timeline: [] };

const isEntry = (value: unknown): value is HistoryEntry => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const o = value as Record<string, unknown>;
  return (
    typeof o.date === "string" &&
    typeof o.summary === "string" &&
    (o.people === undefined ||
      (Array.isArray(o.people) && o.people.every((p) => typeof p === "string")))
  );
};

/** Keep what is well-formed and drop the rest; a bad row is not a reason to lose the file. */
const parseGroupHistory = (raw: unknown): GroupHistory => {
  if (!raw || typeof raw !== "object") {
    return EMPTY;
  }
  const o = raw as Record<string, unknown>;
  const context: Record<string, string> = {};
  if (o.context && typeof o.context === "object") {
    for (const [k, v] of Object.entries(o.context as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) {
        context[k] = v;
      }
    }
  }
  const timeline = Array.isArray(o.timeline) ? o.timeline.filter(isEntry) : [];
  return { context, timeline };
};

let cached: GroupHistory | null = null;

/** The history, read once per process; empty when this computer has none. */
export const groupHistory = (): GroupHistory => {
  if (!cached) {
    const path = join(tenantDataDir(), GROUP_HISTORY_FILE);
    if (existsSync(path)) {
      try {
        cached = parseGroupHistory(JSON.parse(readFileSync(path, "utf-8")));
      } catch {
        cached = EMPTY;
      }
    } else {
      cached = EMPTY;
    }
  }
  return cached;
};

/** Test seam: forget the parsed file so the next call re-reads it. */
export const resetGroupHistoryCache = (): void => {
  cached = null;
};
