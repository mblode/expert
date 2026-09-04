"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { BotMark } from "@/components/bot-mark";
import { TemplateDetail } from "@/components/template-detail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { botIdFrom } from "@/lib/bot-id";
import { captureEvent } from "@/lib/posthog-client";
import { createSeat, SeatError } from "@/lib/seat";
import type { TemplateView } from "@/lib/bot-template";

/**
 * A shared Bot, as the person who was sent the link sees it.
 *
 * The install runs in this browser with that person's own seat on their own
 * computer, not on the control plane: `CreateBot` then `ApplyBotTemplate`, the
 * same two calls the New Bot sheet makes. hello.expert never holds a seat on
 * behalf of a visitor to write to a hub, and this keeps it that way; the only
 * thing it is told afterwards is that one more Bot exists.
 *
 * A Bot is made on the computer the visitor is already bound to, because that
 * is what an account has. Nothing about a template names the computer it came
 * from, and nothing about installing one reaches back to it.
 */
export function TemplatePage({
  draft = false,
  view,
}: {
  /** The owner previewing their own unpublished template. */
  draft?: boolean;
  view: TemplateView;
}): React.ReactElement {
  const { data: session, isPending } = authClient.useSession();
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const { template } = view;
  const hubUrl = session?.hubUrl;
  const seatToken = session?.seatToken;
  const seat = useMemo(
    () => (seatToken && hubUrl ? createSeat(hubUrl, seatToken) : undefined),
    [hubUrl, seatToken],
  );

  const add = async () => {
    if (!seat) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const id = await freeId(seat, template.name);
      const made = await seat.createBot(id);
      // The Bot exists from here. A failed apply leaves a Bot named after its
      // id with the template project's defaults, which is a Bot you can talk
      // to, so this reports rather than pretending nothing happened.
      await seat.applyBotTemplate(made.id, template);
      setAdded(made.id);
      captureEvent("bot_template_installed", { template_id: view.id });
      // The count is the control plane's, and it is not what made the Bot:
      // a failure here must not read as a failed install.
      await fetch(`/api/templates/${view.id}/install`, { method: "POST" }).catch(() => undefined);
    } catch (error) {
      setFailure(
        error instanceof SeatError || error instanceof Error
          ? error.message
          : "Your computer refused to add it.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col gap-6 px-5 py-10">
      <header className="flex flex-col items-center gap-3 text-center">
        <BotMark botId={view.id} profile={{ ...template, id: view.id }} size="hero" />
        <div className="flex items-center gap-2">
          <h1 className="font-semibold text-2xl tracking-tight">{template.name}</h1>
          {draft && <Badge variant="secondary">Unpublished</Badge>}
        </div>
        {template.title && <p className="text-muted-foreground text-sm">{template.title}</p>}
        {template.description && (
          <p className="text-pretty text-muted-foreground text-sm">{template.description}</p>
        )}
        {view.installs > 0 && (
          <p className="text-muted-foreground text-xs">
            {view.installs === 1 ? "1 Bot made from this" : `${view.installs} Bots made from this`}
          </p>
        )}
      </header>

      <TemplateDetail template={template} />

      {/* The action last and after the detail, deliberately: everything this
          will write onto the reader's computer is above the button. */}
      <div className="sticky bottom-0 flex flex-col gap-2 bg-background pt-2 pb-4">
        {added ? (
          <>
            <p className="text-center text-muted-foreground text-sm">
              {template.name} is on your computer as {added}.
            </p>
            <Button render={<Link href="/" />} size="lg">
              Open your computer
            </Button>
          </>
        ) : seat ? (
          <>
            <Button loading={busy} onClick={() => void add()} size="lg">
              Add Bot
            </Button>
            <p className="text-center text-muted-foreground text-xs">
              It gets its own screen, and it reads these instructions as its own.
            </p>
          </>
        ) : (
          <>
            <Button
              disabled={isPending}
              render={<Link href={`/login?next=${encodeURIComponent(`/bot/${view.id}`)}`} />}
              size="lg"
            >
              Sign in to add it
            </Button>
            <p className="text-center text-muted-foreground text-xs">
              {session
                ? "Your account has no computer to add it to yet."
                : "A Bot needs a computer to run on."}
            </p>
          </>
        )}
        {failure && <p className="text-center text-destructive text-sm">{failure}</p>}
      </div>
    </main>
  );
}

/**
 * A Bot id nothing on this computer is using.
 *
 * The name came from someone else, so a collision is the normal case rather
 * than an edge: two people sharing a Chief of Staff is the feature working.
 * A roster read that fails is not fatal, `CreateBot` refuses a duplicate id
 * itself and the person sees that sentence.
 */
async function freeId(
  seat: ReturnType<typeof createSeat>,
  name: string,
  limit = 20,
): Promise<string> {
  const base = botIdFrom(name) || "bot";
  let taken = new Set<string>();
  try {
    const { bots } = await seat.roster();
    taken = new Set(bots.map((bot) => bot.id));
  } catch {
    return base;
  }
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; n <= limit; n++) {
    const candidate = `${base.slice(0, 29)}-${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return base;
}
