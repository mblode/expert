"use client";

import { ArrowLeftIcon } from "blode-icons-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";

import { QrCode } from "@/components/qr-code";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { authClient } from "@/lib/auth-client";
import { captureEvent } from "@/lib/posthog-client";
import { reconnect } from "@/lib/reconnect";
import type { BoundSeat } from "@/lib/reconnect";
import { createSeat, SeatError } from "@/lib/seat";
import type { WhatsAppConfig, WhatsAppGroup } from "@/lib/seat";
import {
  applyAllowedGroups,
  applySettingsDraft,
  DEFAULT_ACCOUNT,
  defaultLinkMethod,
  formatPairingCode,
  inviteCode,
  nextAllowedGroups,
  normalisePhone,
  reduceLink,
  settingsDraft,
} from "@/lib/whatsapp";
import type { LinkMethod, LinkView, SettingsDraft } from "@/lib/whatsapp";

/** The QR rotates every 20 to 60 s and a pairing code lands within a few; 2 s keeps both feeling live. */
const POLL_MS = 2000;
const NOT_RUNNING = "WhatsApp isn't running on this computer yet.";
const COARSE_POINTER = "(pointer: coarse)";
/** Module-level on purpose: a constant is not a reactive value, so no effect has to list it. */
const acct = DEFAULT_ACCOUNT;

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/**
 * The RPC without the page's reaction to it, so an effect can start a call
 * without touching state until it settles: React wants state changes in the
 * continuation, not in the effect body.
 */
async function tryCall<T>(call: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return {
      code: error instanceof SeatError ? error.code : "UNKNOWN",
      message: error instanceof Error ? error.message : "Something went wrong.",
      ok: false,
    };
  }
}

/** The server page already required a session; this only reads the seat off it. */
export function WhatsAppChannel(): React.ReactElement {
  const { data: session, isPending } = authClient.useSession();
  const [recovered, setRecovered] = useState<BoundSeat | null>(null);

  const seat =
    recovered ??
    (session?.seatToken
      ? {
          computerId: session.computerId,
          hubUrl: session.hubUrl,
          seatToken: session.seatToken,
        }
      : null);

  if (isPending && !seat) {
    return <div className="min-h-dvh bg-background" />;
  }

  if (!seat) {
    return (
      <Shell>
        <Alert variant="destructive">
          <AlertDescription>
            {session?.seatError ?? "Signed in, but no seat token was issued for the computer."}
          </AlertDescription>
        </Alert>
        <Button className="w-full" render={<Link href="/" />} size="input" variant="outline">
          Back to the computer
        </Button>
      </Shell>
    );
  }

  return (
    <ChannelPage
      computerId={seat.computerId}
      hubUrl={seat.hubUrl}
      key={seat.seatToken}
      onRecovered={setRecovered}
      seatToken={seat.seatToken}
    />
  );
}

/** Page frame: a way back, a title, one column that fits a phone. */
function Shell({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <Button
          aria-label="Back to the computer"
          render={<Link href="/" />}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowLeftIcon />
        </Button>
        <h1 className="text-sm font-semibold">
          <span className="text-mute">Channels / </span>WhatsApp
        </h1>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {children}
      </main>
    </div>
  );
}

function ChannelPage({
  computerId,
  hubUrl,
  onRecovered,
  seatToken,
}: {
  computerId: string;
  hubUrl: string;
  onRecovered: (seat: BoundSeat) => void;
  seatToken: string;
}): React.ReactElement {
  const seat = useMemo(() => createSeat(hubUrl, seatToken), [hubUrl, seatToken]);
  const [view, dispatch] = useReducer(reduceLink, { kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<WhatsAppGroup[] | null>(null);
  const [config, setConfig] = useState<WhatsAppConfig | null>(null);

  /**
   * One place turns a settled RPC into what the page shows. The bridge not
   * running is a state of the page, not an error; an expired seat is paired
   * again and the page remounts on the new token; anything else is one line
   * under the content, replaced by the next call that works.
   */
  const settle = useCallback(
    async <T,>(outcome: Outcome<T>): Promise<T | undefined> => {
      if (outcome.ok) {
        setError(null);
        return outcome.value;
      }
      if (outcome.code === "DAEMON_DOWN") {
        dispatch({ type: "down" });
        return undefined;
      }
      if (outcome.code === "UNAUTHENTICATED") {
        const next = await reconnect();
        if (next) {
          onRecovered(next);
          return undefined;
        }
      }
      setError(outcome.message);
      return undefined;
    },
    [onRecovered],
  );

  const attempt = useCallback(
    <T,>(call: () => Promise<T>): Promise<T | undefined> => tryCall(call).then(settle),
    [settle],
  );

  const loadAccounts = useCallback(
    () =>
      attempt(() => seat.whatsappAccounts()).then((res) => {
        if (res) {
          dispatch({ accounts: res.accounts, acct, type: "accounts" });
        }
      }),
    [attempt, seat],
  );

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  // Poll while the hub is waiting on the phone, and while a linked socket is
  // down, since it reconnects on its own and the page should follow it back.
  const polling = view.kind === "linking" || view.kind === "closed";
  const linking = view.kind === "linking";
  useEffect(() => {
    if (!polling) {
      return;
    }
    let live = true;
    const tick = async () => {
      const state = await attempt(() => seat.whatsappLink(acct, "status"));
      if (!live || !state) {
        return;
      }
      if (state.status === "open" && linking) {
        captureEvent("whatsapp_linked", { computer_id: computerId });
      }
      dispatch({ state, type: "state" });
    };
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [attempt, computerId, linking, polling, seat]);

  const linked = view.kind === "linked";
  useEffect(() => {
    if (!linked) {
      return;
    }
    let live = true;
    void Promise.all([
      attempt(() => seat.whatsappGroups(acct)),
      attempt(() => seat.whatsappConfig(acct)),
    ]).then(([fetchedGroups, fetchedConfig]) => {
      if (!live) {
        return;
      }
      if (fetchedGroups) {
        setGroups(fetchedGroups.groups);
      }
      if (fetchedConfig) {
        setConfig(fetchedConfig.config);
      }
    });
    return () => {
      live = false;
    };
  }, [attempt, linked, seat]);

  const start = async (method: LinkMethod, phone?: string) => {
    const state = await attempt(() => seat.whatsappLink(acct, "start", phone ? { phone } : {}));
    if (!state) {
      return;
    }
    captureEvent("whatsapp_link_started", { computer_id: computerId, method });
    dispatch({ method, state, type: "state" });
  };

  const unlink = async () => {
    const state = await attempt(() => seat.whatsappLink(acct, "unlink"));
    if (!state) {
      return;
    }
    captureEvent("whatsapp_unlinked", { computer_id: computerId });
    // The owner asked for unlinked; whatever the socket reports on its way
    // down, that is the view. The next load shows the hub's truth.
    dispatch({ type: "unlinked" });
  };

  const writeConfig = async (next: WhatsAppConfig): Promise<WhatsAppConfig | undefined> => {
    const res = await attempt(() => seat.whatsappSetConfig(acct, next));
    if (!res) {
      return undefined;
    }
    setConfig(res.config);
    setGroups((current) =>
      current
        ? applyAllowedGroups(
            current,
            res.config.allowed_groups,
            res.config.group_policy ?? "listed",
          )
        : current,
    );
    return res.config;
  };

  const toggleGroup = async (jid: string, enabled: boolean) => {
    if (!config || !groups) {
      return;
    }
    // The first flip turns the wide-open default into an explicit list.
    await writeConfig({
      ...config,
      allowed_groups: nextAllowedGroups(
        config.allowed_groups,
        groups,
        jid,
        enabled,
        config.group_policy ?? "all",
      ),
      group_policy: "listed",
    });
  };

  const join = async (invite: string): Promise<boolean> => {
    const joined = await attempt(() => seat.whatsappJoinGroup(acct, invite));
    if (!joined) {
      return false;
    }
    const fresh = await attempt(() => seat.whatsappGroups(acct));
    if (fresh) {
      setGroups(fresh.groups);
    }
    // A pasted link is a request to serve that group, so it goes straight on
    // the allowlist rather than appearing switched off.
    if (config) {
      await writeConfig({
        ...config,
        allowed_groups: nextAllowedGroups(
          config.allowed_groups,
          fresh?.groups ?? groups ?? [],
          joined.jid,
          true,
          config.group_policy ?? "all",
        ),
        group_policy: "listed",
      });
    }
    return true;
  };

  return (
    <Shell>
      {view.kind === "loading" && <Waiting label="Checking WhatsApp…" />}
      {view.kind === "down" && (
        <>
          <Alert>
            <AlertDescription>{NOT_RUNNING}</AlertDescription>
          </Alert>
          <Button
            className="w-full"
            onClick={() => void loadAccounts()}
            size="input"
            type="button"
            variant="outline"
          >
            Check again
          </Button>
        </>
      )}
      {view.kind === "unlinked" && <LinkForm onStart={start} />}
      {view.kind === "linking" && <LinkingPanel onCancel={unlink} view={view} />}
      {view.kind === "closed" && (
        <>
          <section className="flex items-center justify-between gap-3 rounded-2xl border border-edge bg-panel px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs text-mute">Reconnecting</p>
              <p className="truncate font-medium">{view.phone ? `+${view.phone}` : "WhatsApp"}</p>
            </div>
            <UnlinkDialog onUnlink={unlink} />
          </section>
          <p className="flex items-center gap-2 text-sm text-mute">
            <Spinner size={14} />
            WhatsApp dropped the connection. It usually comes back on its own.
          </p>
        </>
      )}
      {view.kind === "linked" && (
        <>
          <section className="flex items-center justify-between gap-3 rounded-2xl border border-edge bg-panel px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs text-growth-green">Linked</p>
              <p className="truncate font-medium">{view.phone ? `+${view.phone}` : "WhatsApp"}</p>
            </div>
            <UnlinkDialog onUnlink={unlink} />
          </section>
          <GroupsSection groups={groups} onJoin={join} onToggle={toggleGroup} />
          {config ? (
            <SettingsForm config={config} onSave={writeConfig} />
          ) : (
            <Waiting label="Loading settings…" />
          )}
        </>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </Shell>
  );
}

function Waiting({ label }: { label: string }): React.ReactElement {
  return (
    <p className="flex items-center gap-2 text-sm text-mute">
      <Spinner size={14} />
      {label}
    </p>
  );
}

function subscribeCoarsePointer(onChange: () => void): () => void {
  const query = window.matchMedia(COARSE_POINTER);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Whether this is a touch screen. The server cannot know, so it renders the
 * laptop default and React swaps in the phone's after hydration without a
 * mismatch, which a `useEffect` + `setState` pair would not manage.
 */
function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeCoarsePointer,
    () => window.matchMedia(COARSE_POINTER).matches,
    () => false,
  );
}

function LinkForm({
  onStart,
}: {
  onStart: (method: LinkMethod, phone?: string) => Promise<void>;
}): React.ReactElement {
  const coarse = useCoarsePointer();
  const [chosen, setChosen] = useState<LinkMethod | null>(null);
  const [phone, setPhone] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [pending, setPending] = useState(false);
  const method = chosen ?? defaultLinkMethod(coarse);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    const digits = method === "code" ? normalisePhone(phone) : undefined;
    if (method === "code" && !digits) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setPending(true);
    try {
      await onStart(method, digits ?? undefined);
    } finally {
      setPending(false);
    }
  };

  const choice = (value: LinkMethod, label: string) => (
    <Button
      aria-pressed={method === value}
      onClick={() => setChosen(value)}
      size="input"
      type="button"
      variant={method === value ? "secondary" : "outline"}
    >
      {label}
    </Button>
  );

  return (
    <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}>
      <p className="text-sm text-mute">
        Link a WhatsApp number and Eve answers in the groups and chats you choose.
      </p>
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="sr-only">How to link</legend>
        {choice("code", "Pairing code")}
        {choice("qr", "QR code")}
      </fieldset>
      <FieldGroup className="gap-5">
        {method === "code" ? (
          <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor="wa-phone">Phone number</FieldLabel>
            <Input
              autoComplete="tel"
              hasError={invalid}
              id="wa-phone"
              inputMode="tel"
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+61 412 345 678"
              type="tel"
              value={phone}
            />
            {invalid ? (
              <FieldError>Enter the full number, with its country code.</FieldError>
            ) : (
              <FieldDescription>The number WhatsApp is on, with its country code.</FieldDescription>
            )}
          </Field>
        ) : (
          <p className="text-sm text-mute">
            Have your phone ready: you will scan the code from WhatsApp.
          </p>
        )}
        <Button className="w-full" loading={pending} size="input" type="submit">
          {method === "code" ? "Get a code" : "Show the QR code"}
        </Button>
      </FieldGroup>
    </form>
  );
}

function LinkingPanel({
  onCancel,
  view,
}: {
  onCancel: () => Promise<void>;
  view: Extract<LinkView, { kind: "linking" }>;
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  const cancel = async () => {
    setPending(true);
    try {
      await onCancel();
    } finally {
      setPending(false);
    }
  };

  let display: React.ReactNode;
  if (view.method === "code") {
    display = view.code ? (
      <div className="flex items-center justify-center gap-3 rounded-2xl border border-edge bg-panel py-6 pr-3 pl-5">
        <output
          aria-label="Pairing code"
          className="font-mono text-4xl font-semibold tracking-[0.15em] tabular-nums"
        >
          {formatPairingCode(view.code)}
        </output>
        <CopyButton label="Copy code" size="icon-lg" value={view.code} variant="outline" />
      </div>
    ) : (
      <Waiting label="Getting your code…" />
    );
  } else {
    display = view.qr ? (
      <div className="flex justify-center rounded-2xl bg-white p-3">
        <QrCode label="Scan this from WhatsApp" value={view.qr} />
      </div>
    ) : (
      <Waiting label="Getting a QR code…" />
    );
  }

  return (
    <>
      {display}
      <ol className="list-decimal space-y-1.5 pl-5 text-sm">
        <li>Open WhatsApp on your phone{view.phone ? ` (+${view.phone})` : ""}.</li>
        <li>Tap Settings, then Linked devices.</li>
        <li>Tap Link a device.</li>
        {view.method === "code" ? (
          <li>Tap Link with phone number instead, then enter the code.</li>
        ) : (
          <li>Point the phone at the code above.</li>
        )}
      </ol>
      <Waiting label="Waiting for WhatsApp…" />
      <Button
        className="w-full"
        loading={pending}
        onClick={() => void cancel()}
        size="input"
        type="button"
        variant="outline"
      >
        Start over
      </Button>
    </>
  );
}

function UnlinkDialog({ onUnlink }: { onUnlink: () => Promise<void> }): React.ReactElement {
  const [pending, setPending] = useState(false);
  const confirm = async () => {
    setPending(true);
    try {
      await onUnlink();
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog>
      <DialogTrigger render={<Button size="sm" variant="destructiveSecondary" />}>
        Unlink
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlink this number?</DialogTitle>
          <DialogDescription>
            Eve stops answering on WhatsApp until you link a number again. Your groups and settings
            are kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button size="input" variant="outline" />}>Keep it</DialogClose>
          <Button
            loading={pending}
            onClick={() => void confirm()}
            size="input"
            type="button"
            variant="destructive"
          >
            Unlink
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GroupsSection({
  groups,
  onJoin,
  onToggle,
}: {
  groups: WhatsAppGroup[] | null;
  onJoin: (invite: string) => Promise<boolean>;
  onToggle: (jid: string, enabled: boolean) => Promise<void>;
}): React.ReactElement {
  // One write at a time: a second flip while the first is in flight would
  // build its allowlist from a list that is about to change under it.
  const [busy, setBusy] = useState(false);
  const toggle = async (jid: string, enabled: boolean) => {
    setBusy(true);
    try {
      await onToggle(jid, enabled);
    } finally {
      setBusy(false);
    }
  };

  let list: React.ReactNode;
  if (groups === null) {
    list = <Waiting label="Loading groups…" />;
  } else if (groups.length === 0) {
    list = (
      <p className="text-sm text-mute">
        This number is not in any groups yet. Add it from your phone, or paste an invite link.
      </p>
    );
  } else {
    list = (
      <ul className="divide-y divide-edge rounded-2xl border border-edge">
        {groups.map((group) => (
          <li className="flex min-h-14 items-center gap-3 px-4 py-2" key={group.jid}>
            <label className="min-w-0 flex-1 cursor-pointer" htmlFor={`wa-group-${group.jid}`}>
              <span className="block truncate text-sm font-medium">{group.subject}</span>
              <span className="text-xs text-mute">
                {group.size} {group.size === 1 ? "member" : "members"}
              </span>
            </label>
            <Switch
              checked={group.enabled}
              disabled={busy}
              id={`wa-group-${group.jid}`}
              onCheckedChange={(checked) => void toggle(group.jid, checked)}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">Groups</h2>
        <p className="text-sm text-mute">Eve answers in the groups you switch on.</p>
      </div>
      {list}
      <JoinForm onJoin={onJoin} />
    </section>
  );
}

function JoinForm({
  onJoin,
}: {
  onJoin: (invite: string) => Promise<boolean>;
}): React.ReactElement {
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    const code = inviteCode(text);
    if (!code) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setPending(true);
    try {
      if (await onJoin(code)) {
        setText("");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      <Field data-invalid={invalid || undefined}>
        <FieldLabel htmlFor="wa-invite">Join by invite link</FieldLabel>
        <div className="flex gap-2">
          <Input
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            hasError={invalid}
            id="wa-invite"
            inputMode="url"
            onChange={(event) => setText(event.target.value)}
            placeholder="https://chat.whatsapp.com/…"
            spellCheck={false}
            value={text}
          />
          <Button
            disabled={!text.trim()}
            loading={pending}
            size="input"
            type="submit"
            variant="outline"
          >
            Join
          </Button>
        </div>
        {invalid && <FieldError>That does not look like a WhatsApp invite link.</FieldError>}
      </Field>
    </form>
  );
}

function SettingsForm({
  config,
  onSave,
}: {
  config: WhatsAppConfig;
  onSave: (next: WhatsAppConfig) => Promise<WhatsAppConfig | undefined>;
}): React.ReactElement {
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraft(config));
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settingsDraft(config));

  const edit = (patch: Partial<SettingsDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    const next = applySettingsDraft(config, draft);
    if ("error" in next) {
      setProblem(next.error);
      return;
    }
    setProblem(null);
    setPending(true);
    try {
      const written = await onSave(next.config);
      if (written) {
        setDraft(settingsDraft(written));
        setSaved(true);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      <div>
        <h2 className="text-sm font-semibold">Settings</h2>
        <p className="text-sm text-mute">When Eve answers, and who it reports to.</p>
      </div>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="wa-name">Name</FieldLabel>
          <Input
            autoComplete="off"
            id="wa-name"
            onChange={(event) => edit({ botName: event.target.value })}
            placeholder="Eve"
            value={draft.botName}
          />
          <FieldDescription>What people call it in the chat.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="wa-trigger">Answers in a group when</FieldLabel>
          <NativeSelect
            id="wa-trigger"
            onChange={(event) =>
              edit({ triggerMode: event.target.value as WhatsAppConfig["trigger_mode"] })
            }
            value={draft.triggerMode}
          >
            <NativeSelectOption value="mention">Someone mentions it</NativeSelectOption>
            <NativeSelectOption value="prefix">A message starts with a prefix</NativeSelectOption>
            <NativeSelectOption value="all">Any message arrives</NativeSelectOption>
          </NativeSelect>
        </Field>
        {draft.triggerMode === "prefix" && (
          <Field>
            <FieldLabel htmlFor="wa-prefix">Prefix</FieldLabel>
            <Input
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="font-mono"
              id="wa-prefix"
              onChange={(event) => edit({ triggerPrefix: event.target.value })}
              placeholder="!eve"
              spellCheck={false}
              value={draft.triggerPrefix}
            />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="wa-dm">Answers direct messages from</FieldLabel>
          <NativeSelect
            id="wa-dm"
            onChange={(event) =>
              edit({ dmPolicy: event.target.value as WhatsAppConfig["dm_policy"] })
            }
            value={draft.dmPolicy}
          >
            <NativeSelectOption value="members">People in its groups</NativeSelectOption>
            <NativeSelectOption value="allowlist">Only these numbers</NativeSelectOption>
            <NativeSelectOption value="anyone">Anyone</NativeSelectOption>
          </NativeSelect>
        </Field>
        {draft.dmPolicy === "allowlist" && (
          <Field>
            <FieldLabel htmlFor="wa-allowlist">Numbers</FieldLabel>
            <Textarea
              autoComplete="off"
              className="min-h-24 font-mono text-sm"
              id="wa-allowlist"
              onChange={(event) => edit({ dmAllowlist: event.target.value })}
              placeholder={"+61 412 345 678\n+44 7700 900123"}
              value={draft.dmAllowlist}
            />
            <FieldDescription>One per line, with country codes.</FieldDescription>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="wa-maintainer">Sends reports to</FieldLabel>
          <Input
            autoComplete="tel"
            id="wa-maintainer"
            inputMode="tel"
            onChange={(event) => edit({ maintainer: event.target.value })}
            placeholder="+61 412 345 678"
            type="tel"
            value={draft.maintainer}
          />
          <FieldDescription>
            Feature requests and bug reports from the chat go to this number.
          </FieldDescription>
        </Field>
        {problem && <FieldError>{problem}</FieldError>}
        <div className="flex items-center gap-3">
          <Button disabled={!dirty} loading={pending} size="input" type="submit">
            Save
          </Button>
          {saved && !dirty && <output className="text-sm text-mute">Saved.</output>}
        </div>
      </FieldGroup>
    </form>
  );
}
