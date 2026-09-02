import { siteConfig, trimSlashes } from "./config";

/** Public origin for an invite URL. Never includes the token. */
export function inviteOrigin(request?: Request): string {
  const configured = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) {
    return trimSlashes(configured);
  }
  if (process.env.VERCEL_ENV === "production") {
    return trimSlashes(siteConfig.url);
  }
  const forwarded = request?.headers.get("x-forwarded-host");
  const proto = request?.headers.get("x-forwarded-proto") ?? "https";
  if (forwarded) {
    return trimSlashes(`${proto}://${forwarded.split(",")[0]?.trim()}`);
  }
  const host = request?.headers.get("host");
  if (host) {
    return trimSlashes(`${proto}://${host}`);
  }
  return trimSlashes(siteConfig.url);
}

export function invitePath(purpose: "desk" | "plugins", token: string): string {
  return `/${purpose}/${token}`;
}
