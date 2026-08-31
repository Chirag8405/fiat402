"use client";

/**
 * "scroll" hint for the cold-open beat -- fixed DOM overlay (confirmed with
 * the user over the Html-transform-anchored-in-3D alternative: a
 * screen-space affordance shouldn't perspective-shift or fly offscreen the
 * instant scrolling starts, which an in-scene anchor would). Markup copied
 * verbatim from components/showcase/ColdOpen.tsx's scroll hint.
 *
 * Driven purely by CSS reading --scroll-progress (written by
 * ScrollProvider.tsx's ScrollTrigger, same var the existing
 * .scroll-progress-bar consumes) -- no JS per frame, no React state. Fades
 * out over cold-open's own progress window so it's gone by the time old-way
 * starts, using zoneRange's end boundary for that zone (computed once at
 * module load, not per frame).
 */

import type { CSSProperties } from "react";
import { zoneRange } from "./zoneProgress";

const [, ZONE_0_END] = zoneRange(0);

const hintStyle: CSSProperties = {
  opacity: `clamp(0, calc(1 - var(--scroll-progress, 0) / ${ZONE_0_END}), 1)`,
};

export function ScrollHint() {
  return (
    <div
      className="fixed bottom-10 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1.5 text-[11px] uppercase tracking-widest text-muted-foreground"
      style={hintStyle}
      aria-hidden="true"
    >
      <span>scroll</span>
      <span className="h-6 w-px bg-border" />
    </div>
  );
}
