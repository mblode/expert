import type { Metadata } from "next";
import localFont from "next/font/local";
import { Agentation } from "agentation";

import { TooltipProvider } from "@/components/ui/tooltip";
import { JsonLd } from "@/components/json-ld";
import { siteConfig } from "@/lib/config";
import { AUTHOR, siteGraph } from "@/lib/site";

import "./globals.css";

const glide = localFont({
  display: "swap",
  src: [{ path: "../public/glide-variable.woff2" }],
  variable: "--font-glide",
  weight: "400 900",
});

const emilioLight = localFont({
  display: "swap",
  src: [{ path: "../public/emilio-light.woff" }],
  variable: "--font-emilio-light",
  weight: "300",
});

// Non-brand lead, brand suffix: the product phrase is what a stranger searches
// for; the name already wins the navigational queries (`docs/seo/`).
const siteTitle = `A team of Bots with a computer of their own | ${siteConfig.name}`;

export const metadata: Metadata = {
  authors: [{ name: AUTHOR.name, url: AUTHOR.url }],
  creator: AUTHOR.name,
  description: siteConfig.description,
  metadataBase: new URL(siteConfig.url),
  // No `url` here: it is not per page, and a child cannot override it without
  // declaring the whole block. Consumers fall back to the URL they fetched.
  // The card image comes from app/opengraph-image.tsx by file convention.
  openGraph: {
    description: siteConfig.description,
    locale: "en_AU",
    siteName: siteConfig.name,
    title: siteTitle,
    type: "website",
  },
  // Google's defaults cap the snippet and the image preview, and AI surfaces
  // read against the snippet cap when deciding how much they may quote.
  robots: {
    follow: true,
    googleBot: {
      follow: true,
      index: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
    index: true,
  },
  title: {
    default: siteTitle,
    template: `%s | ${siteConfig.name}`,
  },
  // Only the card type: a title or description here would be inherited
  // verbatim by every inner page, which would then share as the home page.
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html className={`dark ${glide.variable} ${emilioLight.variable} h-full`} lang="en">
      <body className="h-full">
        <JsonLd data={siteGraph()} />
        <TooltipProvider>
          {children}
          {process.env.NODE_ENV === "development" && <Agentation />}
        </TooltipProvider>
      </body>
    </html>
  );
}
