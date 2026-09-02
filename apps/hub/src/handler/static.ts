import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Pixels of the screen are seat-only. The noVNC bundle under /novnc is public. */
export function needsSeatPixelAuth(pathname: string): boolean {
  return pathname === "/vnc" || pathname.startsWith("/vnc/");
}

/** Serve a file from `dir`; `/vnc` and `/vnc/` resolve to the noVNC page. */
export function serveStatic(res: ServerResponse, dir: string, pathname: string): boolean {
  const rel = pathname === "/vnc" || pathname === "/vnc/" ? "/vnc/index.html" : pathname;
  const file = resolve(dir, rel.replace(/^\/+/, ""));
  if (!file.startsWith(dir + sep)) {
    return false;
  }
  const body = tryRead(file);
  if (body) {
    writeFile(res, file, body);
    return true;
  }
  if (rel.startsWith("/novnc/")) {
    const novnc = tryNovnc(rel.slice("/novnc/".length));
    if (novnc) {
      writeFile(res, novnc.path, novnc.body);
      return true;
    }
  }
  return false;
}

function writeFile(res: ServerResponse, path: string, body: Buffer): void {
  res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
  res.end(body);
}

/** `@novnc/novnc` from node_modules: hoisted to the workspace root or local to the hub. */
function tryNovnc(rel: string): { path: string; body: Buffer } | null {
  const roots = [
    resolve(import.meta.dirname, "../../node_modules/@novnc/novnc"),
    resolve(import.meta.dirname, "../../../../node_modules/@novnc/novnc"),
  ];
  for (const root of roots) {
    const p = resolve(root, rel);
    if (!p.startsWith(root + sep)) {
      continue;
    }
    const body = tryRead(p);
    if (body) {
      return { body, path: p };
    }
  }
  return null;
}

/** The file's bytes, or undefined for anything that is not a readable file (ENOENT, EISDIR). */
function tryRead(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}
