import { useState } from "react";

import { pixelUrlFresh } from "./seat";

/**
 * Hold the current pixel URL until the grant is close to expiry or the screen
 * identity changes.
 *
 * `Seat.Status` is polled every couple of seconds and its `vnc_url` carries a
 * short-lived token, so binding an iframe straight to it tears noVNC down and
 * reconnects it on every rotation: the stream never settles and the pane
 * stays black. Both the full pane and the rail thumbnail need this, which is
 * why it lives here rather than beside either of them.
 *
 * Derived from the previous render with state, not a ref written during
 * render, so the React Compiler can still memoise the callers.
 */
export function useVncSrc(incoming: string | undefined, identity: string): string | undefined {
  const [held, setHeld] = useState<{ identity: string; url: string } | undefined>();
  const stale = held === undefined || held.identity !== identity || !pixelUrlFresh(held.url);
  // Set only when it changes: a URL the browser already judges stale would
  // otherwise be re-set on every render, and React would refuse the loop.
  if (incoming && stale && held?.url !== incoming) {
    setHeld({ identity, url: incoming });
    return incoming;
  }
  return held?.identity === identity ? held.url : undefined;
}
