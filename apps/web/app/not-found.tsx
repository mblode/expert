import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Next only injects `noindex` when the response is a real 404. `/_not-found`,
 * the route it reserves for this boundary, answers 200 and so inherited the
 * layout's `index, follow` — an indexable soft 404. Declaring it here covers
 * that route as well as the 404s.
 */
export const metadata: Metadata = {
  robots: { follow: true, index: false },
  title: "Not found",
};

/**
 * A real 404 with somewhere to go next, for people and for agents that read
 * the body: the public pages are listed as links, not only a way home.
 */
const places = [
  { href: "/", label: "The front door" },
  { href: "/guides", label: "Guides" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/login", label: "Sign in" },
];

export default function NotFound(): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <h1 className="text-xl font-semibold">Not found</h1>
        <p className="text-sm text-mute">
          That page does not exist. Where you might have been going:
        </p>
        <ul className="space-y-1 text-sm">
          {places.map((place) => (
            <li key={place.href}>
              <Link className="underline underline-offset-4" href={place.href}>
                {place.label}
              </Link>
            </li>
          ))}
        </ul>
        <Button render={<Link href="/" />} variant="link">
          Back to the computer
        </Button>
      </div>
    </div>
  );
}
