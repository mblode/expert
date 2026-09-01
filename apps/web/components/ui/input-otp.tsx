"use client";

import { OTPInput, OTPInputContext } from "input-otp";
import { useContext, type ComponentProps } from "react";

export function InputOTP({
  className = "",
  containerClassName = "",
  ...props
}: ComponentProps<typeof OTPInput> & { containerClassName?: string }): React.ReactElement {
  return (
    <OTPInput
      className={`disabled:cursor-not-allowed ${className}`}
      containerClassName={`flex items-center gap-2 has-disabled:opacity-50 ${containerClassName}`}
      {...props}
    />
  );
}

export function InputOTPGroup({ className = "", ...props }: ComponentProps<"div">): React.ReactElement {
  return <div className={`flex items-center ${className}`} {...props} />;
}

export function InputOTPSlot({
  index,
  className = "",
  ...props
}: ComponentProps<"div"> & { index: number }): React.ReactElement {
  const ctx = useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = ctx?.slots[index] ?? {};

  return (
    <div
      className={`relative flex size-10 items-center justify-center border-y border-r border-edge bg-panel text-lg first:rounded-l-lg first:border-l last:rounded-r-lg ${isActive ? "ring-1 ring-accent" : ""} ${className}`}
      data-active={isActive}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-6 w-px animate-caret-blink bg-white" />
        </div>
      )}
    </div>
  );
}
