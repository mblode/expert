# SEO and AEO audit of hello.expert, and what the site should grow into

Date: 2026-09-06, evening. Companion to the brief
[`2026-09-06-ai-team-with-its-own-computer.md`](2026-09-06-ai-team-with-its-own-computer.md)
and the fourth pass in [`../AUDIT.md`](../AUDIT.md). The model for the site
map is `donebear/apps/marketing-frontend`, read directly rather than from
memory; its own evidence is quoted where it decided something here.

## 1. Where the site stood this morning, and tonight

Served-HTML evidence, not source. Tools: a FAT Agent audit run from a temp
clone (`spruikco/fat-agent-skill`, `--fetch --url`), Lighthouse locally,
`is-agentic`, and Matt's Search Console export (PageSpeed's keyless API was
out of quota all day, so field data is No data).

| Measure                                      | Morning                                              | Evening                                                                    |
| -------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| FAT SEO / security / overall                 | 73 / 70 / 72                                         | 88 / 100 / 85                                                              |
| Lighthouse SEO                               | not run                                              | 100                                                                        |
| is-agentic (agent readiness)                 | 62, "important blockers"                             | see the watcher result appended below                                      |
| Canonical, share card, JSON-LD, snippet caps | none                                                 | all present                                                                |
| Pages Google may index                       | 2 (home, login)                                      | 7 (home, guides index, 3 guides, about, contact, privacy); login `noindex` |
| Search Console                               | brand queries only, 0 clicks, "hello expert" at 55.9 | unchanged; measure again in two weeks                                      |

What the Search Console rows mean: the domain is not yet associated with
its own name. That is an indexing and entity problem, which the canonical,
the Organization and WebSite graph with `alternateName`, and the trust
pages address; content cannot move it. The one non-brand query,
"ondemand ai expert", is a different category and should not shape the
page.

## 2. What was shipped tonight, and why each thing

- **Trust anchors: `/about`, `/contact`, `/privacy`.** `is-agentic` scores
  their absence as a recommended failure; answer engines and people both
  look for who is behind a product before they cite or sign up. All three
  are written from the code: the privacy page is a data inventory (Turso,
  Resend, Fly volume, Vercel Blob, the AI Gateway, PostHog), not a template.
  The contact email is also the Organization's `contactPoint`.
- **`/guides` with three guides.** donebear's guides are its
  highest-impression pages (348 and 313 impressions on the top two in its
  own Search Console read) and they follow a fixed skeleton whose evidence
  is written down in `docs/gtm/guides-format.md` there: answer in the first
  30% of the page, five takeaways that are true out of context, steps with
  the number in the eyebrow, the honest limit, questions phrased the way
  people type them. The three topics are the three things the product does
  that nothing else explains plainly: the seat, who types passwords and
  codes, and what "an assistant with its own computer" is. Every sentence
  is backed by `api/DESIGN.md`, the README or the FAQ.
- **Markdown twins by content negotiation.** `Accept: text/markdown` on any
  public page returns Markdown with `Vary: Accept` and `X-Robots-Tag:
noindex`, built as a direct `Response` in `proxy.ts` because Next replaces
  `Vary` on rewritten HTML. One content module renders the page, the twin
  and the JSON-LD, so they cannot drift.
- **Crawl paths.** Guides and About sit in the primary nav, not only the
  footer, because Google discounts footer boilerplate and a footer-only
  section can sit unknown for months. Breadcrumbs render visibly on every
  inner page and the `BreadcrumbList` is generated from the same array.
- **Agent surfaces.** `/skill.md` serves the existing skill file; `/llms.txt`
  lists the pages and says the twins exist; the 404 lists where to go.

## 3. The rest of the list, decided

Matt asked about guides, `/switch`, resources, blog, academy, contact,
about and pricing. Each, with donebear as the reference and the decision.

| Section                   | donebear has                                                                                                    | Decision for hello.expert                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guides                    | 8 MDX guides, fixed skeleton, TechArticle schema                                                                | **Built**, 3 guides, same skeleton, content as typed data | Highest-leverage format on donebear's own numbers; facts existed                                                                                                                                                                                                                                                                                                                                                                                                            |
| About, Contact            | Yes, plus a sales contact                                                                                       | **Built**                                                 | Trust anchors; zero invention needed                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Privacy                   | Yes                                                                                                             | **Built** as a data inventory                             | Trust anchor; every line checkable in code                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/switch` and comparisons | `/windows`, `/ios`, `/web` switcher pages and 7 `<competitor>-alternative` pages with FAQ and breadcrumb schema | **Not yet.** Write the first as a brief, then the page    | A comparison page's value is accurate claims about the other product (Grok Bot, OpenAI Operator, Anthropic computer use, browser-agent extensions). `docs/GROK-BOT.md` is a research base, dated 2026-09-02, and nothing here verifies a competitor's current behaviour. Publishing an unverified comparison is the one page type that damages trust if wrong. Slugs to plan: `grok-bot-alternative`, `openai-operator-alternative`, `computer-use-agent-vs-chat-assistant` |
| Pricing                   | Yes: free tier, plans, `SoftwareApplication` with offers, FAQ                                                   | **Not yet.**                                              | There is no price. Sign-up is a waitlist and computers are handed out one at a time. A pricing page with no offer is thin content that ranks for nothing and invites the question it cannot answer. Build it the day a price exists, with `Offer` and `price` as numbers                                                                                                                                                                                                    |
| Blog                      | 19 posts, RSS and Atom, tags                                                                                    | **Not yet.**                                              | Editorial by donebear's own definition ("if it has an opinion, it's a blog post"). It needs a first post worth reading and a cadence; a `/blog` with one entry is worse than none. When it starts, add `feed.xml` and `alternates.types` in the same change                                                                                                                                                                                                                 |
| Resources                 | 3 `free-online-*-resources` landing pages with launch checklists                                                | **Not yet.**                                              | Those are demand-driven pages built on query volume. No keyword tool is bound here and Search Console shows no non-brand demand yet. Build the first one from a pull, not a hunch                                                                                                                                                                                                                                                                                           |
| Academy                   | donebear does not have one                                                                                      | **No.**                                                   | Nothing to model, no content, and "academy" is a promise of a course. The guides are the teachable surface; if they accumulate, `/guides` is the academy                                                                                                                                                                                                                                                                                                                    |

## 4. The order from here

1. **Two weeks of Search Console.** Watch "hello expert" move. If it does
   not, the problem is entity association and the next move is external
   mentions (GitHub README, the author's site, the community), not pages.
2. **Connect the property to the PostHog Search Console source** so the
   monitoring cadence in `seo-program` can run without a paste.
3. **Bind a keyword tool** and rerun the brief's table; then the first
   resources page and the first comparison, each as a brief first.
4. **Promote the Content-Security-Policy** from report-only once the logs
   are quiet through a real session.
5. **Trim client JavaScript on the front door** (the scroll-animated
   how-it-works section and its motion library) for the simulated LCP; a
   `ui-design` and `ui-animation` change.

## 5. Evidence appended after deploy

Read from the served site after the deploy (all with `-A Twitterbot` where
metadata placement matters):

| Check                                                          | Result                                                                                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/about`, `/contact`, `/privacy`, `/guides`, three guide pages | 200, self-canonical, own titles                                                                                                                            |
| `/skill.md`, `/llms.txt`                                       | 200                                                                                                                                                        |
| `Accept: text/markdown` on `/`, `/about`, a guide              | 200, `text/markdown`, `Vary: Accept`, `X-Robots-Tag: noindex`; the same URL without the header is still HTML                                               |
| Guide schema versus DOM                                        | `TechArticle` headline and every breadcrumb name present in the rendered text; two `ld+json` scripts per inner page (site graph, page graph), claims agree |
| Sitemap                                                        | 8 rows, each dated by its content                                                                                                                          |
| 404                                                            | real 404 with links to guides, contact and home                                                                                                            |
| FAT Agent                                                      | SEO 90, security 100, accessibility 87, performance 61, overall 86                                                                                         |
| is-agentic                                                     | still served its 08:16 UTC scan from before any change; not evidence. Rescan tomorrow                                                                      |

Left after this: the `is-agentic` items that remain true, which are an MCP
manifest (there is no MCP server, and none is planned for the site) and
"docs behind auth", which is the login page doing its job.
