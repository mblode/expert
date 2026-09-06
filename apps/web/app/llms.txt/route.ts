import { siteConfig } from "@/lib/config";

/**
 * One route, almost no measurable return, and it costs nothing to keep right.
 * Google needs no such file; this is for agents that look for one.
 */
export function GET(): Response {
  const body = `# ${siteConfig.name}

> ${siteConfig.description}

${siteConfig.name} gives a person a team of Bots that share one persistent Linux computer: a real desktop with a browser, files and a terminal that the Bots drive and the person can take the mouse of at any time, from a laptop or a phone. Bots run routines while nobody is watching, ask the person when a password or a payment is needed, and keep going.

## Pages

- [Home](${siteConfig.url}): what you get, who you get, how to reach it, and the FAQ
- [Sign in](${siteConfig.url}/login): existing accounts; new sign-ups join a waitlist

## Source

- [GitHub](${siteConfig.links.github}): the code, under the MIT licence
- [Author](${siteConfig.links.author}): Matthew Blode
`;
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
