import { AVATAR_COLORS, AVATAR_SHAPES } from "@/lib/seat";
import type { BotProfile } from "@/lib/seat";
import { cn } from "@/lib/utils";

/**
 * A Bot's mark: how it is recognised in the sidebar, the chat header and the
 * screen rail.
 *
 * The colour and the shape are the Bot's own, from the profile the hub keeps
 * on the box and a human edits in the settings panel. A Bot whose profile has
 * not loaded yet still needs a mark, so the id is hashed into a hue for that
 * one case: stable for the same id on every client and every reload, which is
 * the whole job of a mark, and replaced by the stored colour the moment the
 * roster answers.
 *
 * The stored values are checked against the palettes rather than trusted.
 * `avatar_color` lands in an inline style, and the file the hub reads it from
 * is under `/workspace`, where the model's own `write_file` reaches it.
 */
const HUES = [8, 32, 48, 92, 150, 172, 196, 224, 262, 292, 328] as const;

/** Small, stable, and the only property that matters is that it spreads. */
function hash(value: string): number {
  let h = 0;
  for (const char of value) {
    h = (h * 31 + (char.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return h;
}

const SIZES = {
  lg: "size-9 text-sm",
  md: "size-7 text-xs",
  sm: "size-5 text-[10px]",
} as const;

/**
 * The four marks. A circle and a square are rounding; the other two are clip
 * paths, drawn a little inside the box so the letter still has room.
 */
const SHAPES = {
  circle: "rounded-full",
  diamond: "[clip-path:polygon(50%_2%,98%_50%,50%_98%,2%_50%)]",
  hexagon: "[clip-path:polygon(50%_1%,94%_26%,94%_74%,50%_99%,6%_74%,6%_26%)]",
  square: "rounded-[30%]",
} as const;

/** A stored value, or nothing when it is not one the client draws. */
function inPalette<T extends string>(
  allowed: readonly T[],
  value: string | undefined,
): T | undefined {
  return value !== undefined && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

export function BotMark({
  botId,
  className,
  profile,
  size = "md",
}: {
  botId: string;
  className?: string;
  /** Absent while the roster is still loading, or for a Bot it did not list. */
  profile?: BotProfile;
  size?: keyof typeof SIZES;
}): React.ReactElement {
  const color = inPalette(AVATAR_COLORS, profile?.avatar_color);
  const shape = inPalette(AVATAR_SHAPES, profile?.avatar_shape) ?? "circle";
  const hue = HUES[hash(botId) % HUES.length] ?? HUES[0];
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center font-semibold text-white/90 select-none",
        SHAPES[shape],
        SIZES[size],
        className,
      )}
      // Two stops a few degrees apart, so the mark reads as one lit surface
      // rather than a gradient doing decorative work.
      style={{
        backgroundImage: color
          ? `linear-gradient(150deg, color-mix(in oklab, ${color} 88%, white), color-mix(in oklab, ${color} 84%, black))`
          : `linear-gradient(150deg, oklch(0.72 0.15 ${hue}), oklch(0.58 0.16 ${hue + 12}))`,
      }}
    >
      {(profile?.name || botId).slice(0, 1).toUpperCase()}
    </span>
  );
}
