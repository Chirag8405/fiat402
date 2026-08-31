"use client";

/**
 * Section 2 -- "the old way": all three pain points live inside one
 * bordered row-list (composition redesign -- no more one-word-at-a-time
 * floating text). One pinned section, one scrubbed gsap timeline (scrub:
 * true, same as before) drives which row is "active" as the user scrolls,
 * reusing the SAME progress math the old floating-word version used
 * (slice = 1 / PAIN_POINTS.length, start = index * slice was already "which
 * third of this section's scroll range belongs to which pain point") --
 * just applied to a row highlight instead of a word's opacity. Same
 * ScrollTrigger config (pin, start/end -- pin distance unchanged), same
 * scrub-driven onUpdate-imperative-ref idiom HumanMoment.tsx's typewriter
 * uses, no React state added.
 */

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

const PAIN_POINTS = [
  { label: "KYC verification", description: "Identity checks before an agent can transact." },
  { label: "API key provisioning", description: "Manual credential exchange, per integration." },
  { label: "Recurring subscriptions", description: "Standing authorization instead of per-request consent." },
];

export function OldWay() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (!sectionRef.current) return;

    const ctx = gsap.context(() => {
      ScrollTrigger.create({
        trigger: sectionRef.current,
        start: "top top",
        end: "+=140%",
        pin: true,
        // scrub: true (not a numeric value) -- avoids stacking GSAP's own
        // catch-up smoothing on top of Lenis's already-eased scroll
        // position, see HumanMoment.tsx's top comment for the full reasoning.
        scrub: true,
        onUpdate: self => {
          const activeIndex = Math.min(Math.floor(self.progress * PAIN_POINTS.length), PAIN_POINTS.length - 1);
          rowRefs.current.forEach((row, index) => {
            if (!row) return;
            row.classList.toggle("bg-muted", index === activeIndex);
            const label = row.querySelector<HTMLElement>("[data-row-label]");
            if (label) label.classList.toggle("text-primary", index === activeIndex);
          });
        },
      });
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section ref={sectionRef} className="relative flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      <div className="mx-auto w-full max-w-3xl">
        <p className="mb-4 text-xs uppercase tracking-widest text-muted-foreground">the old way</p>

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {PAIN_POINTS.map((point, index) => (
            <div
              key={point.label}
              ref={element => {
                rowRefs.current[index] = element;
              }}
              className="flex items-center gap-4 border-b border-border px-5 py-5 transition-colors duration-150 ease-[var(--ease-out)] last:border-b-0 sm:gap-6 sm:px-6"
            >
              <span className="font-mono text-sm text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
              <div className="min-w-0 flex-1">
                <p data-row-label className="text-lg font-semibold text-foreground transition-colors duration-150 ease-[var(--ease-out)] sm:text-xl">
                  {point.label}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{point.description}</p>
              </div>
              <span className="shrink-0 rounded-full border border-danger/40 bg-danger/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-danger">
                Manual
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
