import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_DISPLAYS } from "@computer/shared";
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
 * Load the roster, mint a row for every Bot this build ships a project for,
 * and refuse to invent tokens for rows that already exist without one.
 *
 * `main` on :1 is the floor: an empty roster gets it whether or not there is
 * a project, because a computer with no Bot has no voice. Everything in
 * `projects` (from `eveProjectIds`) that has no row is minted onto the lowest
 * free screen, which is what makes adding a Bot a deploy: the directory is
 * the agent, and the roster row is bookkeeping the guest can do for itself.
 *
 * Two things this deliberately does not do. It never mints over an existing
 * row, so a token stays the one thing that is issued once. And it never
 * removes a row, so a Bot whose project was deleted keeps its screen and its
 * thread until a person calls `DeleteBot`. The inverse is worth knowing:
 * deleting a Bot whose project is still in the image frees its screen only
 * until the next boot, so removing one for good is removing its directory.
 */
export function ensureRoster(store: BotStore, projects: readonly string[] = []): BotConfig[] {
  const configs = store.load();
  for (const c of configs) {
    if (!c.token) {
      throw new Error(
        `roster bot ${c.id} has no token, restore the file or delete the row; do not mint over a live Bot`,
      );
    }
  }
  // A computer with no Bot has no voice, so an empty roster gets `main` even
  // on a build that ships no Eve project at all.
  const wanted =
    configs.length === 0 && !projects.includes("main") ? ["main", ...projects] : projects;
  let added = 0;
  for (const id of wanted) {
    if (configs.some((c) => c.id === id)) {
      continue;
    }
    const display = lowestFreeDisplay(configs);
    if (display === undefined) {
      console.warn(
        `roster: all ${MAX_DISPLAYS} screens are in use, so bot ${id} has a project but no screen`,
      );
      continue;
    }
    configs.push({ display, id, token: mintToken() });
    added += 1;
  }
  if (added > 0) {
    store.save(configs);
  }
  return configs;
}

function lowestFreeDisplay(configs: readonly BotConfig[]): number | undefined {
  for (let d = 1; d <= MAX_DISPLAYS; d++) {
    if (!configs.some((c) => c.display === d)) {
      return d;
    }
  }
  return undefined;
}

export function ensureRosterAt(path: string, projects: readonly string[] = []): BotConfig[] {
  return ensureRoster(new FileBotStore(path), projects);
}
