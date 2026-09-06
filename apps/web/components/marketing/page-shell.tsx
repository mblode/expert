import Link from "next/link";

import { Footer } from "@/components/shared/footer";
import { Navbar } from "@/components/shared/navbar";

interface Crumb {
  href: string;
  name: string;
}

/**
 * The frame every public page shares: the floating nav, a readable column,
 * the footer. Breadcrumbs render as a visible trail so the BreadcrumbList a
 * page emits is a description of what is on screen, never a claim beyond it.
 */
export function PageShell({
  children,
  crumbs,
}: {
  children: React.ReactNode;
  crumbs?: Crumb[];
}): React.ReactElement {
  return (
    <div className="marketing min-h-full">
      <Navbar />
      <main className="mx-auto w-full max-w-2xl px-4 pt-28 pb-16 sm:px-6" id="main">
        {crumbs && crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-6 text-muted-foreground text-sm">
            <ol className="flex flex-wrap items-center gap-2">
              {crumbs.map((crumb, index) => (
                <li className="flex items-center gap-2" key={crumb.href}>
                  {index > 0 && <span aria-hidden="true">/</span>}
                  {index === crumbs.length - 1 ? (
                    <span aria-current="page" className="text-foreground">
                      {crumb.name}
                    </span>
                  ) : (
                    <Link className="transition-colors hover:text-foreground" href={crumb.href}>
                      {crumb.name}
                    </Link>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        {children}
      </main>
      <Footer />
    </div>
  );
}

export const proseClass =
  "space-y-5 text-pretty text-base/7 text-muted-foreground [&_strong]:text-foreground";
