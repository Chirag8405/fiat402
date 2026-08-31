"use client";

/**
 * Public showcase at "/" -- a single continuous scroll-driven camera
 * journey through 7 zones. Replaces the previous DOM/GSAP stacked-section
 * scrollytelling (components/showcase/*.tsx, left in place unused as a copy
 * reference -- see components/showcase-r3f's ScrollProvider for the
 * carried-over Lenis/ScrollTrigger wiring).
 *
 * Phase 2: zones 0-1 (cold-open, old-way) have real content
 * (ColdOpenZone/OldWayZone in Scene.tsx); zones 2-6 are still Phase 1's
 * wireframe placeholders. ScrollHint is the cold-open "scroll" affordance,
 * rendered as a fixed DOM overlay (not scene-anchored) so it doesn't
 * perspective-shift the instant scrolling starts -- see ScrollHint.tsx.
 *
 * Zone order matches the original 7 story beats 1:1 (cold-open, old-way,
 * bridge, human-decide, live-proof, code, close) -- see
 * components/showcase-r3f/cameraPath.ts.
 *
 * ZERO REAL BACKEND CALLS FROM THIS PAGE, EVER (unchanged rule from the
 * previous implementation): this phase has no fixtures/live-component
 * embedding at all yet, so there's nothing to enforce it against, but it
 * still applies once /console's components get <Html transform>'d into the
 * live-proof zone in a later phase.
 *
 * <Canvas> is the page's sole visual layer (position: fixed, full
 * viewport); the div below it is a plain scroll spacer -- its height gives
 * document.body scrollable distance for ScrollProvider's ScrollTrigger to
 * measure progress against, it carries no literal content of its own.
 *
 * The fixed positioning has to live on an OUTER wrapper div, not on
 * <Canvas>'s own `className` -- R3F's Canvas hardcodes an inline
 * `position: relative; width: 100%; height: 100%` style on the div it
 * wraps its <canvas> in, and an inline style always wins over a class
 * regardless of Tailwind specificity, so a `fixed inset-0` className
 * passed directly to <Canvas> is silently clobbered. With no ancestor
 * giving that div an explicit height (body's height is auto, driven by
 * the tall spacer below), the canvas then collapses to its 300x150
 * default and gets visibly squished. Confirmed via
 * canvas.parentElement.parentElement's computed style while debugging
 * this build.
 */

import { Canvas } from "@react-three/fiber";
import { ZONES, positionCurve } from "../components/showcase-r3f/cameraPath";
import { ScrollProvider } from "../components/showcase-r3f/ScrollProvider";
import { LoadingScreen } from "../components/showcase-r3f/LoadingScreen";
import { Scene } from "../components/showcase-r3f/Scene";
import { FpsMeter } from "../components/showcase-r3f/FpsMeter";
import { ScrollHint } from "../components/showcase-r3f/ScrollHint";

const VH_PER_ZONE = 120;

export default function ShowcasePage() {
  return (
    <>
      <ScrollProvider />
      <LoadingScreen />
      <div className="scroll-progress-bar" aria-hidden="true" />
      <ScrollHint />
      <div className="fixed inset-0 z-0">
        <Canvas dpr={[1, 2]} gl={{ antialias: true }} camera={{ fov: 50, position: positionCurve.points[0].toArray() }}>
          <Scene />
          {process.env.NODE_ENV === "development" && <FpsMeter />}
        </Canvas>
      </div>
      <div style={{ height: `${ZONES.length * VH_PER_ZONE}vh` }} aria-hidden="true" />
    </>
  );
}
