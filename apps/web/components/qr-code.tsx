"use client";

import { create } from "qrcode";
import { useMemo } from "react";

/** Modules of margin the spec asks for; a phone camera needs it to find the edges. */
const QUIET_ZONE = 4;

/**
 * WhatsApp's link string as a QR, drawn as one SVG path so each rotation
 * (every 20 to 60 s) is a re-render, not a fetch. Always black on white: the
 * page is dark and a camera wants the contrast the spec assumes.
 */
export function QrCode({ label, value }: { label: string; value: string }): React.ReactElement {
  const { path, size } = useMemo(() => qrPath(value), [value]);
  const box = size + QUIET_ZONE * 2;
  return (
    <svg
      className="h-auto w-full max-w-72"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${box} ${box}`}
    >
      <title>{label}</title>
      <rect fill="#fff" height={box} width={box} />
      <path d={path} fill="#000" transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`} />
    </svg>
  );
}

function qrPath(value: string): { path: string; size: number } {
  // Level L keeps the symbol small, and small means big modules on a phone
  // screen; there is no logo to survive damage for.
  const { modules } = create(value, { errorCorrectionLevel: "L" });
  const { data, size } = modules;
  let path = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y * size + x]) {
        path += `M${x} ${y}h1v1h-1z`;
      }
    }
  }
  return { path, size };
}
