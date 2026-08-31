"use client";

/**
 * Deliberate loading treatment for the R3F scene's init moment -- matches
 * the page's existing ink/mono visual language (same --color-background,
 * font-mono, --color-primary, uppercase-tracking-widest labels, and
 * .blinking-cursor treatment as components/showcase/ColdOpen.tsx) rather
 * than a blank flash while the canvas/WebGL context spins up.
 *
 * "Ready" = drei's useProgress().active being false (tracks
 * THREE.DefaultLoadingManager -- real infra for asset/texture loading once
 * later phases add textures) AND a minimum-display floor, so a fast load
 * never flashes for a single frame -- reads as an intentional beat, not a
 * broken/incomplete page. `active` (not `progress`) gates readiness
 * because the manager never fires at all when there's nothing queued to
 * load, as is the case in this phase -- `progress` would then sit at its
 * initial 0 forever and the screen would never dismiss; `active` correctly
 * starts (and in this phase, stays) false in that case.
 *
 * Rendered as a DOM sibling of <Canvas> in app/page.tsx, not inside the R3F
 * tree, so it doesn't depend on the WebGL context being healthy to show.
 */

import { useEffect, useState } from "react";
import { useProgress } from "@react-three/drei";

const MIN_DISPLAY_MS = 500;

export function LoadingScreen() {
  const { active, progress } = useProgress();
  const [minFloorPassed, setMinFloorPassed] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMinFloorPassed(true), MIN_DISPLAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const ready = !active && minFloorPassed;

  useEffect(() => {
    if (!ready) return;
    // Let the fade-out transition play before unmounting entirely.
    const timer = setTimeout(() => setHidden(true), 400);
    return () => clearTimeout(timer);
  }, [ready]);

  if (hidden) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 bg-background text-center transition-opacity duration-[400ms] ease-[var(--ease-out)]"
      style={{ opacity: ready ? 0 : 1, pointerEvents: ready ? "none" : "auto" }}
      aria-hidden={ready}
    >
      <span className="font-mono text-6xl font-bold tracking-tighter text-primary sm:text-8xl">402</span>
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
        initializing scene
        <span className="blinking-cursor" aria-hidden="true">
          _
        </span>
      </p>
      <div className="h-px w-40 overflow-hidden bg-border">
        <div
          className="h-full origin-left bg-primary transition-transform duration-150 ease-linear"
          style={{ transform: `scaleX(${Math.max(progress, 4) / 100})` }}
        />
      </div>
    </div>
  );
}
