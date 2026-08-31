"use client";

/**
 * Wires Lenis (inertial smooth scroll) to GSAP's ScrollTrigger -- the
 * standard integration documented by both projects: Lenis drives the actual
 * scroll position, ScrollTrigger.update() is called on every Lenis scroll
 * tick so pinned/scrubbed sections stay in sync with Lenis's eased position
 * rather than the raw (unsmoothed) native scroll, and gsap.ticker (not
 * requestAnimationFrame directly) drives Lenis's own raf loop so both
 * libraries share one animation frame clock.
 *
 * Mounted once at the root of app/page.tsx; every section below registers
 * its own ScrollTrigger-driven timeline against the normal document scroll
 * (no per-section Lenis instances).
 *
 * Also owns the single document-level scroll-progress ScrollTrigger: writes
 * `--scroll-progress` (0-1 across the FULL page, top to bottom) onto
 * documentElement on every scroll tick, imperatively (a CSS custom property
 * write, not React state) so it costs nothing per frame. Two consumers read
 * it purely via CSS: AmbientBackground.tsx's moving wash, and the fixed
 * progress bar rendered in app/page.tsx. One shared trigger for both, rather
 * than each maintaining its own.
 */

import { useEffect, type ReactNode } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { AmbientBackground } from "./AmbientBackground";

gsap.registerPlugin(ScrollTrigger);

export function ScrollProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const lenis = new Lenis({
      autoRaf: false,
    });

    lenis.on("scroll", ScrollTrigger.update);

    function onTick(time: number): void {
      // gsap.ticker's `time` is seconds since the ticker started; Lenis's
      // raf() expects a millisecond timestamp (it only uses it for internal
      // delta calculation, not wall-clock alignment), so the scale here just
      // needs to be consistent frame to frame -- multiplying by 1000 is the
      // documented conversion in Lenis's own GSAP integration recipe.
      lenis.raf(time * 1000);
    }
    gsap.ticker.add(onTick);
    // Lenis already smooths scroll velocity itself -- letting GSAP's ticker
    // ALSO smooth out lag (its default behavior) double-applies easing and
    // reads as sluggish input response. Disabled per Lenis's own integration
    // guidance.
    gsap.ticker.lagSmoothing(0);

    const progressTrigger = ScrollTrigger.create({
      trigger: document.body,
      start: "top top",
      end: "bottom bottom",
      scrub: true,
      onUpdate: self => {
        document.documentElement.style.setProperty("--scroll-progress", String(self.progress));
      },
    });

    // Content below (fixtures, code snippets) can shift layout heights after
    // first paint (font load, hydration) -- one refresh shortly after mount
    // keeps pinned-section trigger points accurate without waiting for a
    // manual resize.
    const refreshTimer = setTimeout(() => ScrollTrigger.refresh(), 200);

    return () => {
      clearTimeout(refreshTimer);
      gsap.ticker.remove(onTick);
      lenis.destroy();
      progressTrigger.kill();
      ScrollTrigger.getAll().forEach(trigger => trigger.kill());
    };
  }, []);

  return (
    <>
      <AmbientBackground />
      {children}
    </>
  );
}
