"use client";

/**
 * R3F-era replacement for components/showcase/ScrollProvider.tsx -- same
 * Lenis+GSAP ScrollTrigger wiring (see that file's comments for the
 * rationale on autoRaf: false, gsap.ticker driving lenis.raf, and
 * lagSmoothing(0)), but the document-level progress trigger now writes
 * BOTH the existing --scroll-progress CSS var (kept for any DOM chrome,
 * e.g. LoadingScreen's progress bar) AND progressStore.value, which is
 * what CameraRig's useFrame reads every frame to drive the camera. No
 * children -- this phase's page has no DOM content layer to wrap, just the
 * fixed canvas and the scroll spacer.
 */

import { useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { progressStore } from "./progressStore";

gsap.registerPlugin(ScrollTrigger);

export function ScrollProvider() {
  useEffect(() => {
    const lenis = new Lenis({
      autoRaf: false,
    });

    lenis.on("scroll", ScrollTrigger.update);

    function onTick(time: number): void {
      lenis.raf(time * 1000);
    }
    gsap.ticker.add(onTick);
    gsap.ticker.lagSmoothing(0);

    const progressTrigger = ScrollTrigger.create({
      trigger: document.body,
      start: "top top",
      end: "bottom bottom",
      scrub: true,
      onUpdate: self => {
        progressStore.value = self.progress;
        document.documentElement.style.setProperty("--scroll-progress", String(self.progress));
      },
    });

    const refreshTimer = setTimeout(() => ScrollTrigger.refresh(), 200);

    return () => {
      clearTimeout(refreshTimer);
      gsap.ticker.remove(onTick);
      lenis.destroy();
      progressTrigger.kill();
      ScrollTrigger.getAll().forEach(trigger => trigger.kill());
    };
  }, []);

  return null;
}
