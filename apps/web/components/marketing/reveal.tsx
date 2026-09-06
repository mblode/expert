"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Fade a block in as it scrolls into view.
 *
 * `eager` is for anything in the first viewport. The server renders a
 * non-eager block at opacity 0 and it stays that way until hydration, the
 * observer and the delay have all run, so a hero wrapped in one has no
 * largest contentful paint until seconds after the HTML arrived (Lighthouse
 * measured 7 s on a slow mobile lab, with an empty LCP element). An eager
 * block is visible in the server HTML and never animates.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  eager = false,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  eager?: boolean;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [isInView, setIsInView] = useState(eager);

  useEffect(() => {
    const el = ref.current;
    if (!el || eager) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "-100px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [eager]);

  return (
    <div
      className={className}
      ref={ref}
      style={
        eager
          ? undefined
          : {
              filter: isInView ? "blur(0px)" : "blur(4px)",
              opacity: isInView ? 1 : 0,
              transform: isInView ? "translateY(0)" : "translateY(8px)",
              transition: `filter 0.65s cubic-bezier(0.25, 1, 0.5, 1) ${delay}s, opacity 0.65s cubic-bezier(0.25, 1, 0.5, 1) ${delay}s, transform 0.65s cubic-bezier(0.25, 1, 0.5, 1) ${delay}s`,
            }
      }
    >
      {children}
    </div>
  );
}
