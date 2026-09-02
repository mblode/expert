"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

/** A 48px-wide track: the thumb is a thumb-sized target on a phone, not a checkbox. */
const Switch = ({ className, ...props }: SwitchPrimitive.Root.Props) => (
  <SwitchPrimitive.Root
    className={cn(
      "peer inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input p-0.5 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-success",
      className,
    )}
    data-slot="switch"
    {...props}
  >
    <SwitchPrimitive.Thumb
      className="pointer-events-none block size-6 rounded-full bg-background shadow-sm transition-transform duration-150 data-checked:translate-x-5"
      data-slot="switch-thumb"
    />
  </SwitchPrimitive.Root>
);

export { Switch };
