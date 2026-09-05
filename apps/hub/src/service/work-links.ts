import { ComputerError } from "@computer/shared";
import type { WorkDestination } from "@computer/shared";

/** Navigation only. Possessing or forwarding this URL grants no seat or plugin access. */
export function workLink(
  destination: WorkDestination,
  bot: string,
  conversation: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = new URL("/work", env.COMPUTER_WEB_URL || "https://hello.expert");
  const hub = env.COMPUTER_PUBLIC_URL;
  let hubUrl: URL | undefined;
  try {
    hubUrl = hub ? new URL(hub) : undefined;
  } catch {
    // Invalid deployment configuration must not leak into a message.
  }
  if (
    !hubUrl ||
    hubUrl.username ||
    hubUrl.password ||
    !["http:", "https:"].includes(hubUrl.protocol) ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
  ) {
    throw new ComputerError("DAEMON_DOWN", "owner work links are not configured on this computer");
  }
  url.searchParams.set("view", destination);
  url.searchParams.set("hub", hubUrl.toString().replace(/\/$/, ""));
  url.searchParams.set("bot", bot);
  if (conversation) url.searchParams.set("conversation", conversation);
  return url.toString();
}
