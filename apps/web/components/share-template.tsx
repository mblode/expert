"use client";

import { useEffect, useState } from "react";

import { BotMark } from "@/components/bot-mark";
import { TemplateDetail } from "@/components/template-detail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { pickSections } from "@/lib/bot-template";
import type { TemplateSections, TemplateView } from "@/lib/bot-template";
import { SeatError } from "@/lib/seat";
import type { BotTemplate, Seat } from "@/lib/seat";

/**
 * Share a Bot as a template.
 *
 * Four steps, and the order is the argument. **Confirm** says what is about
 * to be read off the computer. **Review** shows what was found, with a switch
 * per section, because the one thing here that should never be published by
 * default is what a Bot remembers about the person it works for. **Publish**
 * is a separate decision from saving, so a draft can be looked at first.
 * **Share** hands over the link and says what deleting the template does.
 *
 * The document is read with the owner's own seat, in this browser, and posted
 * to hello.expert. It never goes near another computer until someone opens
 * the link and asks for it.
 */
type Step = "confirm" | "review" | "shared";

const SECTION_LABEL: Record<keyof TemplateSections, string> = {
  instructions: "Instructions",
  memories: "Memories",
  plugins: "Plugins",
  routines: "Routines",
  skills: "Skills",
};

export function ShareTemplate({
  botId,
  botName,
  computerId,
  seat,
}: {
  botId: string;
  botName: string;
  /** Which of the account's computers this Bot is on. The route checks it. */
  computerId: string;
  seat: Seat;
}): React.ReactElement {
  const [step, setStep] = useState<Step>("confirm");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [exported, setExported] = useState<BotTemplate | undefined>();
  const [shared, setShared] = useState<TemplateView | undefined>();
  const [detail, setDetail] = useState(false);
  const [sections, setSections] = useState<TemplateSections>({
    instructions: true,
    // Memory is the Bot's record of the person it works for, so it is the one
    // section that starts off. Everything else is the job the Bot does.
    memories: false,
    plugins: true,
    routines: true,
    skills: true,
  });

  /**
   * A Bot shared before is shared at the same link. Looked up on open rather
   * than assumed, so the sheet opens on what already exists instead of
   * quietly minting a second link for the same Bot.
   */
  useEffect(() => {
    let live = true;
    void fetch("/api/templates")
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{ templates: (TemplateView & { botId: string })[] }>)
          : undefined,
      )
      .then((body) => {
        const mine = body?.templates.find((row) => row.botId === botId);
        if (live && mine) {
          setShared(mine);
          setStep("shared");
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [botId]);

  const build = async () => {
    setBusy(true);
    setFailure(null);
    try {
      setExported(await seat.exportBotTemplate(botId));
      setStep("review");
    } catch (error) {
      setFailure(message(error, "Your computer would not read that Bot."));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!exported) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const template = pickSections(exported, sections);
      // Save, then publish: two calls because they are two decisions, and the
      // row exists either way so a failure between them leaves a draft rather
      // than nothing.
      const created = await post<TemplateView>("/api/templates", "POST", {
        botId,
        computerId,
        template,
      });
      const published = await post<TemplateView>(`/api/templates/${created.id}`, "PATCH", {
        published: true,
      });
      setShared(published);
      setStep("shared");
    } catch (error) {
      setFailure(message(error, "Could not create the link."));
    } finally {
      setBusy(false);
    }
  };

  const update = async () => {
    if (!shared) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const template = await seat.exportBotTemplate(botId);
      setShared(
        await post<TemplateView>(`/api/templates/${shared.id}`, "PUT", {
          template: pickSections(template, sections),
        }),
      );
    } catch (error) {
      setFailure(message(error, "Could not update the template."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!shared) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await post(`/api/templates/${shared.id}`, "DELETE");
      setShared(undefined);
      setExported(undefined);
      setStep("confirm");
    } catch (error) {
      setFailure(message(error, "Could not delete the template."));
    } finally {
      setBusy(false);
    }
  };

  const body = (): React.ReactElement => {
    if (step === "shared" && shared) {
      return <Shared onUpdate={() => void update()} busy={busy} view={shared} />;
    }
    if (step === "review" && exported) {
      const picked = pickSections(exported, sections);
      return (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
            <BotMark botId={botId} profile={{ ...picked, id: botId }} size="xl" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-sm">{picked.name}</p>
              <p className="truncate text-muted-foreground text-xs">
                {picked.description || "No description"}
              </p>
            </div>
            <Badge variant="secondary">Unpublished</Badge>
          </div>

          <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {(Object.keys(SECTION_LABEL) as (keyof TemplateSections)[]).map((key) => (
              <label
                className="flex items-center gap-3 px-4 py-3 text-sm"
                key={key}
                htmlFor={`share-${key}`}
              >
                <span className="flex-1">{SECTION_LABEL[key]}</span>
                <span className="text-muted-foreground text-xs">{count(exported, key)}</span>
                <Switch
                  checked={sections[key]}
                  disabled={count(exported, key) === 0}
                  id={`share-${key}`}
                  onCheckedChange={(next: boolean) =>
                    setSections((prev) => ({ ...prev, [key]: next }))
                  }
                />
              </label>
            ))}
          </div>

          <Button onClick={() => setDetail((open) => !open)} size="sm" variant="ghost">
            {detail ? "Hide details" : "View details"}
          </Button>
          {detail && <TemplateDetail template={picked} />}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          {botName} will build a template from its instructions, memories, skills, routines and
          plugins. Nothing is shared until you publish it, and no key, token or account ever travels
          with it.
        </p>
        <p className="text-muted-foreground text-sm">
          Whoever opens the link can add a copy of {botName} to their own computer.
        </p>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {body()}
        {failure && <p className="pt-3 text-destructive text-sm">{failure}</p>}
      </div>
      <DialogFooter className="border-border border-t px-5 py-3">
        {step === "shared" ? (
          <>
            <Button
              className="mr-auto text-destructive"
              disabled={busy}
              onClick={() => void remove()}
              type="button"
              variant="ghost"
            >
              Delete template
            </Button>
            <DialogClose render={<Button type="button" variant="ghost" />}>Done</DialogClose>
          </>
        ) : (
          <>
            <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
            {step === "confirm" ? (
              <Button loading={busy} onClick={() => void build()} type="button">
                Continue
              </Button>
            ) : (
              <Button loading={busy} onClick={() => void publish()} type="button">
                Publish
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </div>
  );
}

/** The link, and what turning it off means. */
function Shared({
  busy,
  onUpdate,
  view,
}: {
  busy: boolean;
  onUpdate: () => void;
  view: TemplateView;
}): React.ReactElement {
  // Derived during render rather than held in an effect: this sheet only ever
  // renders after someone clicked, so there is no server pass to disagree
  // with, and the link is not something that changes under it.
  const url = typeof window === "undefined" ? "" : `${window.location.origin}/bot/${view.id}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
        <BotMark botId={view.id} profile={{ ...view.template, id: view.id }} size="xl" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-sm">{view.template.name}</p>
          <p className="text-muted-foreground text-xs">
            {view.installs === 1 ? "1 Bot made from this" : `${view.installs} Bots made from this`}
          </p>
        </div>
        <Badge variant={view.published ? "success" : "secondary"}>
          {view.published ? "Shared" : "Unpublished"}
        </Badge>
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 p-2 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{url || "…"}</span>
        <CopyButton label="Copy the link" value={url} />
      </div>

      <p className="text-muted-foreground text-sm">
        Anyone with this link can add a copy of {view.template.name} to their own computer. Deleting
        the template turns the link off; Bots already made from it stay where they are.
      </p>

      <Button disabled={busy} onClick={onUpdate} size="sm" variant="outline">
        Update from this Bot
      </Button>
    </div>
  );
}

function count(template: BotTemplate, key: keyof TemplateSections): number {
  if (key === "instructions") {
    return template.instructions ? 1 : 0;
  }
  return template[key].length;
}

async function post<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
    method,
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      (payload as { error?: string } | null)?.error ?? `That did not work (${res.status}).`,
    );
  }
  return payload as T;
}

function message(error: unknown, fallback: string): string {
  return error instanceof SeatError || error instanceof Error ? error.message : fallback;
}
