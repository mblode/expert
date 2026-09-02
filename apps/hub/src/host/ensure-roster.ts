import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FileBotStore, mintToken } from "../service/provision.ts";
import type { BotStore } from "../service/provision.ts";
import type { BotConfig } from "../service/bots.ts";

/** Persist a shared hub→Eve secret next to the roster. */
export function ensureEveSecret(secretPath: string, existing?: string): string {
  if (existing && existing.length > 0) {
    persistSecret(secretPath, existing);
    return existing;
  }
  try {
    const fromDisk = readFileSync(secretPath, "utf-8").trim();
    if (fromDisk) {
      return fromDisk;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const minted = randomBytes(24).toString("base64url");
  persistSecret(secretPath, minted);
  return minted;
}

function persistSecret(path: string, secret: string): void {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
}

/**
 * Load the roster, mint `main` on :1 if the file is empty, and refuse to
 * invent tokens for rows that already exist without one.
 */
export function ensureRoster(store: BotStore): BotConfig[] {
  const configs = store.load();
  if (configs.length === 0) {
    const fresh: BotConfig[] = [{ display: 1, id: "main", token: mintToken() }];
    store.save(fresh);
    return fresh;
  }
  for (const c of configs) {
    if (!c.token) {
      throw new Error(
        `roster bot ${c.id} has no token, restore the file or delete the row; do not mint over a live Bot`,
      );
    }
  }
  return configs;
}

export function ensureRosterAt(path: string): BotConfig[] {
  return ensureRoster(new FileBotStore(path));
}
