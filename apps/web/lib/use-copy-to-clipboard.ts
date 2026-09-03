"use client";

import { useEffect, useRef, useState } from "react";

export const useCopyToClipboard = ({
  timeout = 2000,
  onCopy,
}: {
  timeout?: number;
  onCopy?: () => void;
} = {}) => {
  const [isCopied, setIsCopied] = useState(false);
  const reset = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(reset.current), []);

  const copyToClipboard = async (value: string) => {
    // Optional on `clipboard`, not on `writeText`: the whole API is absent
    // outside a secure context, which is how the box gets opened over plain
    // http on a LAN address. Reading `.writeText` off it there threw a
    // TypeError before the try below could catch anything.
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      return;
    }

    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setIsCopied(true);

      if (onCopy) {
        onCopy();
      }

      if (timeout !== 0) {
        // Held so unmounting mid-countdown does not set state on a dead
        // component, and so a second copy restarts the tick rather than
        // clearing the check the first one just drew.
        window.clearTimeout(reset.current);
        reset.current = window.setTimeout(() => {
          setIsCopied(false);
        }, timeout);
      }
    } catch (error) {
      console.error(error);
    }
  };

  return { copyToClipboard, isCopied };
};
