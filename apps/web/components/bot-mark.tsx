import { cn } from "@/lib/utils";

/**
 * A Bot's mark: how it is recognised in the sidebar, the chat header and the
 * screen rail.
 *
 * The colour is derived from the Bot's id rather than stored, because a Bot on
 * the hub is an id and a screen and nothing else yet. That is deliberate: an
 * invented "brand colour" persisted nowhere would drift the moment a profile
 * does exist. A hash keeps it stable for the same id on every client and every
 * reload, which is the whole job of a mark.
 *
 * Eleven hues, matching the range a Bot profile will eventually pick from.
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

export function BotMark({
  botId,
  className,
  size = "md",
}: {
  botId: string;
  className?: string;
  size?: keyof typeof SIZES;
}): React.ReactElement {
  const hue = HUES[hash(botId) % HUES.length] ?? HUES[0];
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold text-white/90 select-none",
        SIZES[size],
        className,
      )}
      // Two stops a few degrees apart, so the mark reads as one lit surface
      // rather than a gradient doing decorative work.
      style={{
        backgroundImage: `linear-gradient(150deg, oklch(0.72 0.15 ${hue}), oklch(0.58 0.16 ${hue + 12}))`,
      }}
    >
      {botId.slice(0, 1).toUpperCase()}
    </span>
  );
}
