export const siteConfig = {
  description:
    "The Linux computer your AI agent uses. A standing Linux computer your agents drive and you can take over.",
  installCommand: "npx skills add https://hello.expert",
  links: {
    author: "https://blode.co",
    github: "https://github.com/mblode/expert-computer",
    login: "/login",
  },
  name: "Expert",
  url: "https://hello.expert",
};

/** The Fly computer this deployment attaches to. `NEXT_PUBLIC_HUB_URL` overrides it. */
export const DEFAULT_HUB_URL = "https://mblode-computer.fly.dev";

export function trimSlashes(url: string): string {
  return url.trim().replace(/\/+$/u, "");
}
