"use client";

import { CheckIcon } from "blode-icons-react";
import { useState } from "react";
import type { FormEvent } from "react";

import { BotMark, COLOR_LABEL, SHAPE_LABEL } from "@/components/bot-mark";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AVATAR_COLORS, AVATAR_SHAPES, SeatError } from "@/lib/seat";
import type { BotProfile, Seat } from "@/lib/seat";
import { cn } from "@/lib/utils";

/** The hub's caps, so a long name is caught while typing rather than on save. */
const MAX = { description: 500, name: 48, title: 64 } as const;

/**
 * Who a Bot is, edited by the human whose computer it runs on.
 *
 * This is not a preferences pane: the hub folds the name, the label and the
 * description into that Bot's system prompt, so saving here changes how the
 * agent introduces itself and what it thinks it is for. The description says
 * so, because a field that quietly rewrites an agent's identity should say
 * that it does.
 *
 * What is deliberately not here: instructions, skills and schedules live in
 * `apps/eve/bots/<id>/agent/` in git and need a build and a restart, so they
 * are a deploy rather than a form. Memory is the Bot's own file to write.
 */
export function BotSettings({
  botId,
  onSaved,
  onShare,
  profile,
  seat,
}: {
  botId: string;
  onSaved: (profile: BotProfile) => void;
  /**
   * Open the share sheet. Absent on a hub too old to export a template, the
   * way the settings gear itself is absent on one too old to serve profiles:
   * a button whose first call is a 404 is worse than no button.
   */
  onShare?: () => void;
  /** Absent until the roster answers; the form waits rather than guessing. */
  profile?: BotProfile;
  seat: Seat;
}): React.ReactElement {
  const [edited, setEdited] = useState<BotProfile | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The roster can answer after the dialog is open, so the stored profile is
  // what is shown until the human touches a field, and the edit is what is
  // shown from then on. Derived rather than copied into state on arrival: a
  // draft seeded by an effect is a draft that can be overwritten mid-typing.
  const draft = edited ?? profile;

  if (!draft) {
    return (
      <p className="px-1 py-8 text-center text-muted-foreground text-sm">
        Reading {botId}’s profile from the computer…
      </p>
    );
  }

  const edit = (patch: Partial<BotProfile>) => {
    setEdited({ ...draft, ...patch });
    setSaved(false);
    setFailure(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      // The hub answers with what it stored, which is trimmed and may differ
      // from what was typed: show that rather than the draft.
      const stored = await seat.setBotProfile(draft);
      setEdited(stored);
      onSaved(stored);
      setSaved(true);
    } catch (error) {
      setFailure(
        error instanceof SeatError || error instanceof Error
          ? error.message
          : "The computer refused the change.",
      );
    } finally {
      setBusy(false);
    }
  };

  const nameMissing = draft.name.trim().length === 0;

  return (
    <form className="flex min-h-0 flex-col" onSubmit={(event) => void save(event)}>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {/* The mark first and large, because this sheet is about who the Bot
            is and the mark is the part a person recognises before they read
            anything. It updates as the shapes and colours below are picked,
            so the preview is the subject rather than a swatch in a form. */}
        <div className="flex justify-center py-6">
          <BotMark botId={botId} profile={draft} size="hero" />
        </div>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="bot-name">Name</FieldLabel>
            <Input
              aria-describedby={nameMissing ? "bot-name-error" : undefined}
              autoComplete="off"
              hasError={nameMissing}
              id="bot-name"
              maxLength={MAX.name}
              onChange={(event) => edit({ name: event.target.value })}
              placeholder={botId}
              value={draft.name}
            />
            <FieldDescription>
              What it calls itself. Its id on the computer stays {botId}.
            </FieldDescription>
            {/* Save is disabled without one, and a dead button at the foot of
                a sheet does not say which field it is waiting on. */}
            {nameMissing && (
              <FieldError id="bot-name-error">A Bot needs a name to be called by.</FieldError>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="bot-title">Label</FieldLabel>
            <Input
              autoComplete="off"
              id="bot-title"
              maxLength={MAX.title}
              onChange={(event) => edit({ title: event.target.value })}
              placeholder="night shift"
              value={draft.title}
            />
            <FieldDescription>
              A few words under the name. Leave it empty for none.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="bot-description">Description</FieldLabel>
            <Textarea
              id="bot-description"
              maxLength={MAX.description}
              onChange={(event) => edit({ description: event.target.value })}
              placeholder="What this Bot is for."
              rows={3}
              value={draft.description}
            />
            <FieldDescription>
              The name, the label and this go into {draft.name || botId}’s system prompt, so they
              change how it works, not just how it looks.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Character</FieldLabel>
            {/* One card, shapes over colours, each drawn as itself rather than
                as a labelled button: the thing being chosen is a picture, so a
                row of words with a picture attached puts the label in front of
                the choice. The name is still on the button for a screen
                reader, which is where the word belongs. */}
            <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap justify-center gap-3">
                {AVATAR_SHAPES.map((shape) => (
                  <button
                    aria-label={SHAPE_LABEL[shape]}
                    aria-pressed={draft.avatar_shape === shape}
                    className={cn(
                      "grid size-11 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      draft.avatar_shape === shape && "ring-2 ring-foreground/60",
                    )}
                    key={shape}
                    onClick={() => edit({ avatar_shape: shape })}
                    type="button"
                  >
                    <BotMark botId={botId} profile={{ ...draft, avatar_shape: shape }} size="lg" />
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap justify-center gap-3">
                {AVATAR_COLORS.map((color) => (
                  <button
                    aria-label={COLOR_LABEL[color]}
                    aria-pressed={draft.avatar_color === color}
                    className={cn(
                      "grid size-11 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      draft.avatar_color === color && "ring-2 ring-foreground/60",
                    )}
                    key={color}
                    onClick={() => edit({ avatar_color: color })}
                    type="button"
                  >
                    <span
                      className="size-7 rounded-full border border-border/60"
                      style={{ backgroundColor: color }}
                    />
                  </button>
                ))}
              </div>
            </div>
            <FieldDescription>How this Bot’s mark looks everywhere.</FieldDescription>
          </Field>

          {failure && <FieldError>{failure}</FieldError>}
        </FieldGroup>

        {/* Last, and outside the form: sharing is not a field of the Bot, it
            is a thing you do with one. What it hands out is everything above
            plus what this Bot has learned and been taught, which is why the
            sheet it opens shows all of that with a switch beside each part
            rather than publishing on this click. */}
        {onShare && (
          <div className="mt-6 flex flex-col gap-2 rounded-xl border border-border p-4">
            <p className="font-medium text-sm">Share as Template</p>
            <p className="text-muted-foreground text-sm">
              Hand someone a link that adds a copy of {draft.name || botId} to their own computer.
              No key, token or account travels with it.
            </p>
            <Button
              className="self-start"
              onClick={onShare}
              size="sm"
              type="button"
              variant="outline"
            >
              Share as Template
            </Button>
          </div>
        )}
      </div>

      <DialogFooter className="border-border border-t px-5 py-3">
        {saved && (
          <output className="mr-auto flex items-center gap-1.5 text-muted-foreground text-xs">
            <CheckIcon className="size-3.5" />
            Saved to the computer
          </output>
        )}
        <DialogClose render={<Button type="button" variant="ghost" />}>Close</DialogClose>
        <Button disabled={nameMissing} loading={busy} type="submit">
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
