"use client";

import { CheckIcon } from "blode-icons-react";
import { useState } from "react";
import type { FormEvent } from "react";

import { BotMark } from "@/components/bot-mark";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AVATAR_COLORS, AVATAR_SHAPES, SeatError } from "@/lib/seat";
import type { AvatarShape, BotProfile, Seat } from "@/lib/seat";
import { cn } from "@/lib/utils";

/** The hub's caps, so a long name is caught while typing rather than on save. */
const MAX = { description: 500, name: 48, title: 64 } as const;

const SHAPE_LABEL: Record<AvatarShape, string> = {
  circle: "Circle",
  diamond: "Diamond",
  hexagon: "Hexagon",
  square: "Square",
};

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
  profile,
  seat,
}: {
  botId: string;
  onSaved: (profile: BotProfile) => void;
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
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="bot-name">Name</FieldLabel>
            <Input
              autoComplete="off"
              id="bot-name"
              maxLength={MAX.name}
              onChange={(event) => edit({ name: event.target.value })}
              placeholder={botId}
              value={draft.name}
            />
            <FieldDescription>
              What it calls itself. Its id on the computer stays {botId}.
            </FieldDescription>
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
            <FieldLabel>Mark</FieldLabel>
            <div className="flex items-center gap-4">
              <BotMark botId={botId} profile={draft} size="lg" />
              <div className="flex flex-wrap gap-1.5">
                {AVATAR_COLORS.map((color) => (
                  <button
                    aria-label={color}
                    aria-pressed={draft.avatar_color === color}
                    className={cn(
                      "size-7 rounded-full border border-border/60 outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring",
                      draft.avatar_color === color
                        ? "ring-2 ring-ring ring-offset-2 ring-offset-background"
                        : "hover:scale-105",
                    )}
                    key={color}
                    onClick={() => edit({ avatar_color: color })}
                    style={{ backgroundColor: color }}
                    type="button"
                  />
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {AVATAR_SHAPES.map((shape) => (
                <Button
                  aria-pressed={draft.avatar_shape === shape}
                  key={shape}
                  onClick={() => edit({ avatar_shape: shape })}
                  size="xs"
                  type="button"
                  variant={draft.avatar_shape === shape ? "secondary" : "outline"}
                >
                  <BotMark botId={botId} profile={{ ...draft, avatar_shape: shape }} size="sm" />
                  {SHAPE_LABEL[shape]}
                </Button>
              ))}
            </div>
          </Field>

          {failure && <FieldError>{failure}</FieldError>}
        </FieldGroup>
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
