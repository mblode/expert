/**
 * Author Eve connection files. The durable result is
 * `agent/connections/<name>.ts` on the guest, not a row in Turso.
 *
 * Vibey's overlay is a standalone Eve project at `/workspace/eve/bots`.
 */

export const AUTH_KINDS = ["static", "oauth"] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

const OAUTH_STATUSES = ["none", "needs_login", "connected"] as const;
export type OauthStatus = (typeof OAUTH_STATUSES)[number];

/** Standalone overlay (vcmc-agent layout). Nested `bots/main` is the other shape. */
export const GUEST_CONNECTIONS_DIR = "/workspace/eve/bots/agent/connections";

/** `planConnectionFile` returns one and `connectionView` takes one. @public */
export interface ConnectionDraft {
  authKind: AuthKind;
  connectorId?: string;
  description: string;
  envVar?: string;
  filename: string;
  guestPath: string;
  name: string;
  source: string;
  url: string;
}

/** What the browser may see. Never includes a pasted key. */
export interface ConnectionView {
  authKind: AuthKind;
  filename: string;
  hasCredential: boolean;
  name: string;
  oauthStatus: OauthStatus;
  path: string;
  url: string;
}

export interface ConnectionFailure {
  error: string;
  status: 400 | 404 | 409 | 502;
}

function isAuthKind(value: string): value is AuthKind {
  return (AUTH_KINDS as readonly string[]).includes(value);
}

function connectionSlug(name: string): string | undefined {
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 40);
  return slug || undefined;
}

function parseConnectionUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function hostnameName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "") || "plugin";
  } catch {
    return "plugin";
  }
}

function envVarFor(slug: string): string {
  return `COMPUTER_CONNECTION_${slug.replaceAll("-", "_").toUpperCase()}`;
}

function connectorIdFor(url: string, slug: string): string {
  try {
    // Vercel Connect MCP ids are `mcp.<host>/<name>` when the host is not
    // already the MCP hostname, and `<host>/<name>` when it is (Linear is
    // `mcp.linear.app/myagent`).
    const host = new URL(url).hostname;
    return `${host}/${slug}`;
  } catch {
    return `mcp.invalid/${slug}`;
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * A static key lives in a Fly secret named by `envVar`, never in this
 * source and never in the HTML. OAuth is Vercel Connect; the browser
 * only does consent.
 */
export function planConnectionFile(input: {
  authKind?: string;
  credential?: string;
  name?: string;
  url?: string;
}): ConnectionDraft | ConnectionFailure {
  const url = parseConnectionUrl(input.url ?? "");
  if (!url) {
    return { error: "Paste an http or https address for the plugin.", status: 400 };
  }
  const authKind = (input.authKind ?? "static").trim();
  if (!isAuthKind(authKind)) {
    return { error: "Choose a pasted key or sign-in.", status: 400 };
  }
  const label = (input.name ?? "").trim() || hostnameName(url);
  if (label.length > 80) {
    return { error: "Keep the name under 80 characters.", status: 400 };
  }
  const slug = connectionSlug(label);
  if (!slug) {
    return { error: "Give the plugin a short name.", status: 400 };
  }
  const filename = `${slug}.ts`;
  const guestPath = `${GUEST_CONNECTIONS_DIR}/${filename}`;
  const description = `${label} tools.`;
  const envVar = authKind === "static" ? envVarFor(slug) : undefined;
  const connectorId = authKind === "oauth" ? connectorIdFor(url, slug) : undefined;
  return {
    authKind,
    ...(connectorId ? { connectorId } : {}),
    description,
    ...(envVar ? { envVar } : {}),
    filename,
    guestPath,
    name: slug,
    source: renderConnectionSource({
      authKind,
      connectorId,
      description,
      envVar,
      url,
    }),
    url,
  };
}

/** True when a static key was posted. The key itself is discarded after this. */
export function acceptedStaticKey(authKind: AuthKind, credential: string | undefined): boolean {
  return authKind === "static" && Boolean(credential?.trim());
}

function renderConnectionSource(input: {
  authKind: AuthKind;
  connectorId?: string;
  description: string;
  envVar?: string;
  url: string;
}): string {
  if (input.authKind === "oauth") {
    const connector = input.connectorId ?? connectorIdFor(input.url, "plugin");
    return `${[
      'import { connect } from "@vercel/connect/eve";',
      'import { defineMcpClientConnection } from "eve/connections";',
      'import { once } from "eve/tools/approval";',
      "",
      "export default defineMcpClientConnection({",
      "  approval: once(),",
      `  auth: connect(${quote(connector)}),`,
      `  description: ${quote(input.description)},`,
      `  url: ${quote(input.url)},`,
      "});",
      "",
    ].join("\n")}`;
  }

  const envVar = input.envVar ?? "COMPUTER_CONNECTION_PLUGIN";
  return `${[
    'import { defineMcpClientConnection } from "eve/connections";',
    'import { once } from "eve/tools/approval";',
    "",
    "export default defineMcpClientConnection({",
    "  approval: once(),",
    "  auth: {",
    `    getToken: async () => ({ token: process.env.${envVar}! }),`,
    "  },",
    `  description: ${quote(input.description)},`,
    `  url: ${quote(input.url)},`,
    "});",
    "",
  ].join("\n")}`;
}

export function connectionView(
  draft: ConnectionDraft,
  extra: { hasCredential?: boolean } = {},
): ConnectionView {
  const hasCredential = extra.hasCredential ?? false;
  return {
    authKind: draft.authKind,
    filename: draft.filename,
    hasCredential,
    name: draft.name,
    oauthStatus: draft.authKind === "oauth" ? "needs_login" : hasCredential ? "connected" : "none",
    path: draft.guestPath,
    url: draft.url,
  };
}

export function connectionStatusLabel(view: ConnectionView): string {
  if (view.authKind === "oauth") {
    return view.oauthStatus === "connected" ? "Connected" : "Needs login";
  }
  return view.hasCredential ? "Connected" : "Needs a key";
}
