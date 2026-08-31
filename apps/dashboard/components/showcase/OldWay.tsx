"use client";

/**
 * Section 2 -- "the old way": pain points staged one at a time as the user
 * scrolls, each crossed out as the next appears. One pinned section, one
 * scrubbed gsap.timeline (scrub: 1, tied to scroll position -- not a
 * trigger-once reveal), same pattern as components/showcase/Bridge.tsx's
 * bridge sequence.
 */

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

const PAIN_POINTS = ["KYC verification", "API key provisioning", "Recurring subscriptions"];

export function OldWay() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const strikeRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!sectionRef.current) return;

    const ctx = gsap.context(() => {
      const timeline = gsap.timeline({
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top top",
          end: "+=200%",
          pin: true,
          scrub: 1,
        },
      });

      const slice = 1 / PAIN_POINTS.length;
      PAIN_POINTS.forEach((_, index) => {
        const start = index * slice;
        const item = itemRefs.current[index];
        const strike = strikeRefs.current[index];
        if (!item || !strike) return;

        timeline.fromTo(item, { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: slice * 0.35, ease: "none" }, start);

        // Crossed out once the NEXT item is about to appear, not immediately
        // -- the last item never gets struck (nothing replaces it, it's the
        // one the section leaves the viewer on).
        if (index < PAIN_POINTS.length - 1) {
          timeline.fromTo(strike, { scaleX: 0 }, { scaleX: 1, duration: slice * 0.3, ease: "none" }, start + slice * 0.6);
        }
      });
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section ref={sectionRef} className="relative flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6">
      <p className="mb-4 font-mono text-xs uppercase tracking-widest text-muted-foreground">the old way</p>
      <div className="flex flex-col items-start gap-5">
        {PAIN_POINTS.map((point, index) => (
          <div
            key={point}
            ref={element => {
              itemRefs.current[index] = element;
            }}
            className="relative text-3xl font-semibold text-foreground opacity-0 sm:text-5xl"
          >
            {point}
            <span
              ref={element => {
                strikeRefs.current[index] = element;
              }}
              className="absolute left-0 top-1/2 h-[3px] w-full origin-left scale-x-0 bg-danger"
              aria-hidden="true"
            />
          </div>
        ))}
      </div>
    </section>
  );
}
