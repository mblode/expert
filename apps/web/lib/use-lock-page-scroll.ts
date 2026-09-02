import { useEffect } from "react";

/**
 * A phone will otherwise steal one-finger moves as page scroll. The desk
 * overlay keeps pinch-zoom; everything else stays put.
 */
export function useLockPageScroll(): void {
  useEffect(() => {
    const html = document.documentElement;
    const { body } = document;
    const prevHtml = html.style.overflow;
    const prevBody = body.style.cssText;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.inset = "0";
    body.style.overscrollBehavior = "none";

    const prevent = (event: TouchEvent) => {
      const { target } = event;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest("input, textarea, [role='application']")) {
        return;
      }
      event.preventDefault();
    };
    document.addEventListener("touchmove", prevent, { passive: false });
    return () => {
      html.style.overflow = prevHtml;
      body.style.cssText = prevBody;
      document.removeEventListener("touchmove", prevent);
    };
  }, []);
}
