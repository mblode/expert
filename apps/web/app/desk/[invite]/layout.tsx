import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Desk",
};

export const viewport: Viewport = {
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0a0a0b",
  userScalable: false,
  viewportFit: "cover",
  width: "device-width",
};

export default function DeskInviteLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  return children;
}
