export const siteConfig = {
  description: "Vercel Eve and a computer. On the web, desktop, and your phone.",
  installCommand: "npx skills add https://hello.expert",
  links: {
    author: "https://blode.co",
    github: "https://github.com/mblode/expert-computer",
    login: "/login",
  },
  name: "Expert",
  url: "https://hello.expert",
};

/** Blode Fly computer. Fallback when a session has no bound hub yet. */
export const DEFAULT_HUB_URL = "https://mblode-computer.fly.dev";

/**
 * True when serving real traffic in production. `next build` also runs with
 * NODE_ENV=production but has no secrets, so it is excluded.
 */
export const isProductionRuntime =
  process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build";

export function trimSlashes(url: string): string {
  return url.trim().replace(/\/+$/u, "");
}
