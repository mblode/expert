// Which WhatsApp Web build version the socket claims to be.
//
// WhatsApp enforces a minimum at handshake, and rejects anything too old with a
// 405 "Connection Failure" *before* pairing, so a stale version breaks a linked
// session and a fresh QR link identically, and never surfaces as an auth error.
//
// Baileys' own `fetchLatestBaileysVersion()` does not ask WhatsApp: it scrapes
// the version pinned in the Baileys GitHub repo, which lags whenever WhatsApp
// rolls forward before the library catches up. That lag took this bridge down
// with no deploy on our side. `fetchLatestWaWebVersion()` queries
// web.whatsapp.com and is the only source that tracks what is actually
// enforced, so it leads here and the repo pin is only a fallback.

import type { Logger } from "pino";

export type WaVersion = [number, number, number];
export type WaVersionSource = "wa-web" | "baileys-repo";

export interface ResolvedWaVersion {
  version: WaVersion;
  source: WaVersionSource;
}

interface VersionFetchResult {
  version: WaVersion;
}

export interface ResolveWaVersionArgs {
  fetchWaWeb: () => Promise<VersionFetchResult>;
  fetchBaileys: () => Promise<VersionFetchResult>;
  logger: Pick<Logger, "info" | "warn">;
}

/** A version is only usable if it is a triple of finite numbers. */
const isUsable = (version: unknown): version is WaVersion =>
  Array.isArray(version) &&
  version.length === 3 &&
  version.every((part) => typeof part === "number" && Number.isFinite(part));

/**
 * Resolve the WA Web version to hand to makeWASocket.
 *
 * Prefers WhatsApp's own published version, falling back to the Baileys repo pin
 * so a scrape failure degrades to the old behaviour instead of failing the boot
 * outright, a stale version at least still connects while WhatsApp tolerates it.
 */
export const resolveWaVersion = async ({
  fetchWaWeb,
  fetchBaileys,
  logger,
}: ResolveWaVersionArgs): Promise<ResolvedWaVersion> => {
  try {
    const { version } = await fetchWaWeb();
    if (isUsable(version)) {
      return { source: "wa-web", version };
    }
    logger.warn({ version }, "wa-web returned an unusable version");
  } catch (error) {
    logger.warn({ error }, "failed to fetch the WhatsApp Web version");
  }

  const { version } = await fetchBaileys();
  logger.warn(
    { version },
    "falling back to the Baileys repo version pin; this lags WhatsApp and can be refused with 405",
  );
  return { source: "baileys-repo", version };
};
