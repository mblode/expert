"use client";

import { useState } from "react";
import type { FormEvent } from "react";

import { BotMark } from "@/components/bot-mark";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AVATAR_COLORS, AVATAR_SHAPES, SeatError } from "@/lib/seat";
import type { AvatarColor, AvatarShape, BotProfile, Seat } from "@/lib/seat";
import { botIdFrom } from "@/lib/bot-id";
import { cn } from "@/lib/utils";

const MAX = { description: 500, name: 48 } as const;

/**
 * Make a Bot from the seat.
 *
 * Two calls, not one: `CreateBot` mints the roster row, the screen and the
 * token, and `SetBotProfile` writes who it is. The wire stays as it was, and
 * the failure modes stay separable: a Bot that exists with a default mark is
 * recoverable from the settings sheet, where a half-created Bot would not be.
 *
 * What it does not ask for is instructions. A Bot made here runs the template
 * project, so what makes it itself is its profile, and the description is
 * folded into its system prompt before its first turn: "what is this Bot for"
 * is the brief, not decoration.
 */
export function NewBot({
  existingIds,
  onCreated,
  seat,
}: {
  /** For the name collision, which the hub would otherwise refuse on save. */
  existingIds: readonly string[];
  onCreated: (created: { display: number; id: string; profile: BotProfile }) => void;
  seat: Seat;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [shape, setShape] = useState<AvatarShape>("circle");
  const [color, setColor] = useState<AvatarColor>(AVATAR_COLORS[6] ?? AVATAR_COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const id = botIdFrom(name);
  const taken = existingIds.includes(id);
  const draft: BotProfile = {
    avatar_color: color,
    avatar_shape: shape,
    description,
    id: id || "new",
    name: name.trim(),
    title: "",
  };

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const made = await seat.createBot(id);
      // The Bot exists from here on. A failed profile write leaves it named
      // after its id with a hashed mark, which is a Bot you can rename, so
      // this reports rather than pretends the create did not happen.
      const profile = await seat.setBotProfile({ ...draft, id: made.id });
      onCreated({ display: made.display, id: made.id, profile });
    } catch (error) {
      setFailure(
        error instanceof SeatError || error instanceof Error
          ? error.message
          : "The computer refused to make it.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex min-h-0 flex-col" onSubmit={(event) => void create(event)}>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex justify-center py-6">
          <BotMark botId={id || "new"} profile={draft} size="hero" />
        </div>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="new-bot-name">Name</FieldLabel>
            <Input
              autoComplete="off"
              id="new-bot-name"
              maxLength={MAX.name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name your Bot"
              value={name}
            />
            <FieldDescription>
              {id ? `The computer will call it ${id}, and that part cannot change.` : " "}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="new-bot-description">What is it for?</FieldLabel>
            <Textarea
              id="new-bot-description"
              maxLength={MAX.description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="The job you are making it for."
              rows={3}
              value={description}
            />
            <FieldDescription>
              This goes into its system prompt, so it is the brief rather than a note to yourself.
              You can rewrite it whenever.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Character</FieldLabel>
            <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap justify-center gap-3">
                {AVATAR_SHAPES.map((option) => (
                  <button
                    aria-label={option}
                    aria-pressed={shape === option}
                    className={cn(
                      "grid size-11 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      shape === option && "ring-2 ring-foreground/60",
                    )}
                    key={option}
                    onClick={() => setShape(option)}
                    type="button"
                  >
                    <BotMark
                      botId={id || "new"}
                      profile={{ ...draft, avatar_shape: option }}
                      size="lg"
                    />
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap justify-center gap-3">
                {AVATAR_COLORS.map((option) => (
                  <button
                    aria-label={option}
                    aria-pressed={color === option}
                    className={cn(
                      "grid size-11 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      color === option && "ring-2 ring-foreground/60",
                    )}
                    key={option}
                    onClick={() => setColor(option)}
                    type="button"
                  >
                    <span
                      className="size-7 rounded-full border border-border/60"
                      style={{ backgroundColor: option }}
                    />
                  </button>
                ))}
              </div>
            </div>
          </Field>

          {taken && <FieldError>There is already a Bot called {id} on this computer.</FieldError>}
          {failure && <FieldError>{failure}</FieldError>}
        </FieldGroup>
      </div>

      <DialogFooter className="border-border border-t px-5 py-3">
        <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
        <Button disabled={!id || taken} loading={busy} type="submit">
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
