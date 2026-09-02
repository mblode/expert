import { useEffect, useState } from "react";

export interface VisualViewportBox {
  height: number;
  offsetTop: number;
  width: number;
}

/**
 * iOS Safari shrinks the visual viewport when the software keyboard is up.
 * Layout against that box, not `100dvh`, or the keyboard covers the desk.
 */
export function useVisualViewport(): VisualViewportBox {
  const [box, setBox] = useState<VisualViewportBox>({
    height: 0,
    offsetTop: 0,
    width: 0,
  });

  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => {
      if (vv) {
        setBox({ height: vv.height, offsetTop: vv.offsetTop, width: vv.width });
        return;
      }
      setBox({ height: window.innerHeight, offsetTop: 0, width: window.innerWidth });
    };
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return box;
}
