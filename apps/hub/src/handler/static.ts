import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  // A Next export ships its own fonts and route manifests. Without these the
  // browser gets application/octet-stream and silently drops the font.
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

/**
 * Pixels of the screen are seat-only; the rest of the bundle is public.
 *
 * `/` is deliberately not here. It is the control panel, and the control panel
 * is where you pair — gating it behind the token pairing produces is a door
 * locked with the key inside. It ships no pixels of its own: the desktop
 * arrives through the `/vnc/` iframe, which is still gated below, and the
 * WebSocket behind it checks the seat token again on upgrade.
 */
export function needsSeatPixelAuth(pathname: string): boolean {
  return (
    pathname === "/vnc" ||
    pathname.startsWith("/vnc/") ||
    pathname === "/debug.html"
  );
}

export function serveStatic(req: IncomingMessage, res: ServerResponse, dir: string, pathname: string): boolean {
  let rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.startsWith("/vnc") && (rel === "/vnc" || rel === "/vnc/")) rel = "/vnc/index.html";
  const safe = join(dir, rel.replace(/^\/+/, ""));
  if (!safe.startsWith(dir)) return false;
  if (!existsSync(safe)) {
    // optional @novnc/novnc from node_modules
    if (rel.startsWith("/novnc/")) {
      const novnc = tryNovnc(rel.slice("/novnc/".length));
      if (novnc) {
        writeFile(res, novnc.path, novnc.body);
        return true;
      }
    }
    return false;
  }
  writeFile(res, safe, readFileSync(safe));
  void req;
  return true;
}

function writeFile(res: ServerResponse, path: string, body: Buffer): void {
  res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
  res.end(body);
}

function tryNovnc(rel: string): { path: string; body: Buffer } | null {
  const roots = [
    resolve(process.cwd(), "node_modules/@novnc/novnc"),
    resolve(import.meta.dirname, "../../node_modules/@novnc/novnc"),
    resolve(import.meta.dirname, "../../../../node_modules/@novnc/novnc"),
  ];
  for (const root of roots) {
    const p = join(root, rel);
    // Defence in depth: URL normalisation already blocks "..", the containment
    // check makes the novnc branch match its sibling above.
    if (!p.startsWith(root)) continue;
    if (existsSync(p)) return { path: p, body: readFileSync(p) };
  }
  return null;
}
