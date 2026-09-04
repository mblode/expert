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
  /** The settings sheet, where the mark is the subject rather than a label. */
  hero: "size-20",
  lg: "size-9",
  md: "size-7",
  sm: "size-5",
  /** A roster row: big enough to be scanned down a list of eight. */
  xl: "size-11",
} as const;

/**
 * The eight marks. Circle, square, squircle and blob are rounding; the rest
 * are clip paths, drawn a little inside the box so the letter still has room,
 * which is why none of them is a bare triangle.
 */
const SHAPES = {
  blob: "[border-radius:62%_38%_54%_46%/45%_58%_42%_55%]",
  circle: "rounded-full",
  diamond: "[clip-path:polygon(50%_2%,98%_50%,50%_98%,2%_50%)]",
  hexagon: "[clip-path:polygon(50%_1%,94%_26%,94%_74%,50%_99%,6%_74%,6%_26%)]",
  square: "rounded-[30%]",
  squircle: "rounded-[42%]",
  tablet: "[clip-path:inset(14%_2%_14%_2%_round_34%)]",
  wedge: "[clip-path:polygon(2%_2%,98%_2%,98%_66%,50%_98%,2%_66%)]",
} as const;

/**
 * Eyes have to contrast with the mark they are on, and one of the palette
 * colours is black: dark eyes there are a blank face, which reads as a
 * rendering bug rather than as a Bot. Relative luminance of the sRGB value,
 * with the threshold low enough that only the near-black end flips, because
 * dark eyes are the house style everywhere else.
 *
 * The hashed default never flips: those hues are mid-tone by construction.
 */
function darkMark(hex: string | undefined): boolean {
  if (!hex) {
    return false;
  }
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0) < 0.05;
}

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
  const eyes = darkMark(color) ? "bg-white/85" : "bg-black/80";
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center gap-[15%] select-none",
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
      {/* A face, not an initial. Two Bots whose names start with the same
          letter used to wear the same mark at a glance, and the letter is the
          one part of a mark a person cannot change; the shape and the colour
          are the Bot's own and are what the eye actually sorts on. Percentages
          rather than pixels so one pair of eyes is right at every size. */}
      <span className={cn("block w-[11%] rounded-full", eyes)} style={EYE} />
      <span className={cn("block w-[11%] rounded-full", eyes)} style={EYE} />
    </span>
  );
}

/** Tall ovals: wider than this reads as a button, narrower as a scratch. */
const EYE = { aspectRatio: "1 / 2.2" } as const;
