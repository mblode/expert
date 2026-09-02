"use client";

import { useEffect, useRef, useState } from "react";

export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [isInView, setIsInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
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
  }, []);

  return (
    <div
      className={className}
      ref={ref}
      style={{
        filter: isInView ? "blur(0px)" : "blur(4px)",
        opacity: isInView ? 1 : 0,
        transform: isInView ? "translateY(0)" : "translateY(8px)",
        transition: `filter 0.65s cubic-bezier(0.25, 1, 0.5, 1) ${delay}s, opacity 0.65s cubic-bezier(0.25, 1, 0.5, 1) ${delay}s, transform 0.65s cubic-bezier(0.25, 1, 0.5, 1) ${delay}s`,
      }}
    >
      {children}
    </div>
  );
}
