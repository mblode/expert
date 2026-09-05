import { readTokenFile, writeTokenFile } from "./provision.ts";
import type { CodingSession } from "./coding.ts";

export interface CodingIntent {
  key: string;
  hash: string;
  agent: string;
  result?: CodingSession;
  source_conversation_id?: string;
  notified?: boolean;
  next_check_at?: number;
  failures?: number;
}
export interface CodingIntentStore {
  load(): CodingIntent[];
  save(rows: CodingIntent[]): void;
}
export class MemoryCodingIntentStore implements CodingIntentStore {
  private rows: CodingIntent[] = [];
  load(): CodingIntent[] {
    return this.rows;
  }
  save(rows: CodingIntent[]): void {
    this.rows = rows;
  }
}
/** Written before contacting the provider, so an uncertain launch can be reconciled. */
export class FileCodingIntentStore implements CodingIntentStore {
  constructor(private readonly path: string) {}
  load(): CodingIntent[] {
    const rows = readTokenFile(this.path, "coding intents") ?? [];
    return rows.map((row) => {
      const value = row as CodingIntent;
      if (
        !value ||
        typeof value.key !== "string" ||
        typeof value.hash !== "string" ||
        typeof value.agent !== "string" ||
        !/^bc-[0-9a-f-]{36}$/.test(value.agent) ||
        (value.source_conversation_id !== undefined &&
          typeof value.source_conversation_id !== "string") ||
        (value.notified !== undefined && typeof value.notified !== "boolean") ||
        (value.next_check_at !== undefined && !Number.isFinite(value.next_check_at)) ||
        (value.failures !== undefined &&
          (!Number.isSafeInteger(value.failures) || value.failures < 0)) ||
        (value.result !== undefined &&
          (!value.result ||
            value.result.agent !== value.agent ||
            typeof value.result.conversation_id !== "string" ||
            typeof value.result.repo !== "string" ||
            typeof value.result.url !== "string" ||
            typeof value.result.summary !== "string" ||
            typeof value.result.branch !== "string" ||
            typeof value.result.pr_url !== "string" ||
            !["pending", "active", "awaitingInput", "complete", "error", "stale"].includes(
              value.result.state,
            )))
      ) {
        throw new Error("invalid coding intent store");
      }
      return value;
    });
  }
  save(rows: CodingIntent[]): void {
    writeTokenFile(this.path, rows);
  }
}
