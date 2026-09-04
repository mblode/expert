---
description: "Find and fix what stops a site being crawled, indexed, or quoted. Use for indexing problems, Core Web Vitals, structured data, redirects and canonicals."
---

# Technical search

Fetch the page, do not look at it. `curl` the URL and read the markup a
crawler gets; a screenshot tells you what a browser with scripts made of
it, which is a different document.

## The order that matters

1. **Can it be reached.** robots.txt, the response code, redirect chains,
   a canonical pointing somewhere else, a `noindex` nobody meant.
2. **Is it indexed.** Search Console coverage: what is excluded and why.
   "Crawled, currently not indexed" at scale usually means thin or
   duplicate pages, not a technical bug.
3. **Is the content in the HTML.** Text that only exists after a script
   runs is text an answer engine may never quote.
4. **Does the markup match the page.** Title, one h1, headings in order,
   structured data that describes what is actually visible. Structured
   data that lies is worse than none.
5. **Speed, as the field measures it.** Core Web Vitals from real users
   when the site has them, lab numbers only as a hint. Fix the largest
   contentful paint before anything cosmetic.
6. **Duplicates.** Parameters, trailing slashes, http and https, www and
   apex, pagination. One URL per thing, canonical to it.

## Fixing

Draft PR, one class of problem per PR, in the site's own repo. The body
says the before and the after, the URLs affected, and what to watch in
Search Console for the two weeks after it merges.

Three changes get an explicit warning in the message, because each of
them can remove a site from search: robots.txt, `noindex`, and canonical
tags. Show the exact diff and say what it will do.

Never fix these on production directly, whatever the tool offers on
screen.
