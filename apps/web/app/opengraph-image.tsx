import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { siteConfig } from "@/lib/config";

export const alt = `${siteConfig.name}: a team of Bots with a computer of their own`;
export const size = { height: 630, width: 1200 };
export const contentType = "image/png";

// Module scope: the asset does not depend on the request. process.cwd() is
// apps/web on Vercel and in `next build`. Satori reads WOFF; the variable
// woff2 display face would throw, so the card uses the light serif alone.
const emilio = await readFile(join(process.cwd(), "public/emilio-light.woff"));

export default function Image(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        alignItems: "flex-start",
        background: "#0a0a0a",
        color: "#f5f5f5",
        display: "flex",
        flexDirection: "column",
        fontFamily: "Emilio",
        height: "100%",
        justifyContent: "space-between",
        padding: 80,
        width: "100%",
      }}
    >
      <div style={{ fontSize: 40, letterSpacing: -1, opacity: 0.7 }}>{siteConfig.name}</div>
      <div style={{ fontSize: 88, letterSpacing: -3, lineHeight: 1.05, maxWidth: 1000 }}>
        A team of Bots with a computer of their own.
      </div>
      <div style={{ fontSize: 32, opacity: 0.6 }}>hello.expert</div>
    </div>,
    { ...size, fonts: [{ data: emilio, name: "Emilio", style: "normal", weight: 300 }] },
  );
}
