"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { connectionStatusLabel } from "@/lib/connection-file";
import type { AuthKind, ConnectionView } from "@/lib/connection-file";
import { INVITE_HEADER } from "@/lib/invite-access";
import { captureEvent } from "@/lib/posthog-client";

export function InvitePlugins({
  computerId,
  inviteToken,
  label,
}: {
  computerId: string;
  inviteToken: string;
  label: string;
}): React.ReactElement {
  const [plugins, setPlugins] = useState<ConnectionView[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("static");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    captureEvent("plugins_opened", { computer_id: computerId, source: "invite" });
  }, [computerId]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/connections", {
        body: JSON.stringify({
          authKind,
          ...(authKind === "static" && key ? { credential: key } : {}),
          invite: inviteToken,
          name,
          url,
        }),
        headers: { "content-type": "application/json", [INVITE_HEADER]: inviteToken },
        method: "POST",
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : "Could not add that plugin.";
        setError(message);
        return;
      }
      const plugin =
        body && typeof body === "object" && "plugin" in body
          ? (body.plugin as ConnectionView)
          : null;
      if (plugin && typeof plugin.name === "string") {
        setPlugins((current) => [...current.filter((row) => row.name !== plugin.name), plugin]);
        captureEvent("plugin_added", { computer_id: computerId, auth_kind: plugin.authKind });
      }
      setName("");
      setUrl("");
      setKey("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full bg-ink px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <header className="space-y-1">
          <p className="text-xs text-mute">{label}</p>
          <h1 className="text-2xl font-semibold">Plugins</h1>
          <p className="text-sm text-mute">
            Add a tool Eve can use. Chat stays in WhatsApp. Skills stay as files on the computer.
          </p>
        </header>

        {plugins.length > 0 && (
          <ul className="flex flex-col gap-3">
            {plugins.map((plugin) => (
              <li className="rounded-2xl border border-edge bg-panel px-4 py-3" key={plugin.path}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{plugin.name}</p>
                    <p className="truncate text-xs text-mute">{plugin.url}</p>
                    <p className="mt-1 font-mono text-[0.7rem] text-mute">{plugin.filename}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-secondary px-2.5 py-1 text-xs">
                    {connectionStatusLabel(plugin)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <h2 className="text-lg font-medium">Add a plugin</h2>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="plugin-name">Name</FieldLabel>
              <Input
                autoComplete="off"
                id="plugin-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="Done Bear"
                value={name}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="plugin-url">Address</FieldLabel>
              <Input
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                id="plugin-url"
                inputMode="url"
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://…"
                spellCheck={false}
                type="url"
                value={url}
              />
              <FieldDescription>The tool&apos;s web address, not a password.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="plugin-auth">How it signs in</FieldLabel>
              <NativeSelect
                id="plugin-auth"
                onChange={(event) => setAuthKind(event.target.value as AuthKind)}
                value={authKind}
              >
                <NativeSelectOption value="static">A key I paste</NativeSelectOption>
                <NativeSelectOption value="oauth">Sign in with the tool</NativeSelectOption>
              </NativeSelect>
            </Field>
            {authKind === "static" && (
              <Field>
                <FieldLabel htmlFor="plugin-key">Key</FieldLabel>
                <Input
                  autoComplete="off"
                  id="plugin-key"
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="Paste once. It is not shown again."
                  type="password"
                  value={key}
                />
                <FieldDescription>
                  Stored as a secret on the computer. The page never shows it back.
                </FieldDescription>
              </Field>
            )}
            {authKind === "oauth" && (
              <FieldDescription>
                Sign-in happens in the browser. Eve keeps the result as a connection file.
              </FieldDescription>
            )}
          </FieldGroup>
          {error && (
            <p className="text-sm text-red-300" role="alert">
              {error}
            </p>
          )}
          <Button className="w-full" disabled={busy || !url} size="lg" type="submit">
            Add plugin
          </Button>
        </form>
      </div>
    </div>
  );
}
