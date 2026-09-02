import type { Metadata } from "next";
import localFont from "next/font/local";
import { Agentation } from "agentation";

import { siteConfig } from "@/lib/config";

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

const siteTitle = `${siteConfig.name} | The Linux computer your AI agent uses`;

export const metadata: Metadata = {
  description: siteConfig.description,
  metadataBase: new URL(siteConfig.url),
  openGraph: {
    description: siteConfig.description,
    siteName: siteConfig.name,
    title: siteTitle,
    type: "website",
    url: siteConfig.url,
  },
  title: {
    default: siteTitle,
    template: `%s | ${siteConfig.name}`,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html className={`${glide.variable} ${emilioLight.variable} h-full`} lang="en">
      <body className="h-full">
        {children}
        {process.env.NODE_ENV === "development" && <Agentation />}
      </body>
    </html>
  );
}
