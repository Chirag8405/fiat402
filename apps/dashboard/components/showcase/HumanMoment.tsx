"use client";

/**
 * Section 4 -- the emotional beat: AI flags, human decides. The AI's real
 * humanSummary text (from fixtures/travelbot-mismatch-decline.json's
 * "pending" event -- the run that actually resolved to a human Decline, not
 * the clean-approve one) types on screen as the user scrolls, then a
 * Confirm/Decline choice visually resolves toward Decline, matching what
 * actually happened in that captured run.
 *
 * Typewriter is driven by ScrollTrigger's own onUpdate (scroll progress),
 * not setInterval/setTimeout -- text is sliced by progress and written
 * directly via a ref (imperative DOM write) rather than React state, so this
 * doesn't trigger a re-render on every scroll tick.
 */

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import travelbotMismatchDecline from "../../fixtures/travelbot-mismatch-decline.json";

const HUMAN_SUMMARY =
  (travelbotMismatchDecline.events[0] as { aiHumanSummary?: string }).aiHumanSummary ??
  "The request is for booking a flight, but the merchant sells premium data; mismatch requires human review.";

/** Typewriter reaches 100% of the text by this fraction of scroll progress, leaving the remainder for the Confirm/Decline resolution. */
const TYPE_END_PROGRESS = 0.65;
const RESOLVE_START_PROGRESS = 0.75;

export function HumanMoment() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const messageRef = useRef<HTMLSpanElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const declineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sectionRef.current || !messageRef.current || !confirmRef.current || !declineRef.current) return;

    const ctx = gsap.context(() => {
      gsap.set(confirmRef.current, { autoAlpha: 1, scale: 1 });
      gsap.set(declineRef.current, { autoAlpha: 0.35, scale: 0.94 });

      const timeline = gsap.timeline({
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top top",
          end: "+=250%",
          pin: true,
          scrub: 1,
          onUpdate: self => {
            const typeProgress = Math.min(self.progress / TYPE_END_PROGRESS, 1);
            const charCount = Math.floor(typeProgress * HUMAN_SUMMARY.length);
            if (messageRef.current) messageRef.current.textContent = HUMAN_SUMMARY.slice(0, charCount);
          },
        },
      });

      timeline.to(confirmRef.current, { autoAlpha: 0.35, scale: 0.94, ease: "none", duration: 0.12 }, RESOLVE_START_PROGRESS);
      timeline.to(declineRef.current, { autoAlpha: 1, scale: 1, ease: "none", duration: 0.15 }, RESOLVE_START_PROGRESS + 0.05);
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section ref={sectionRef} className="relative flex min-h-screen flex-col items-center justify-center gap-10 bg-background px-6">
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">TravelBot · flagged for review</p>

      <p className="max-w-2xl text-center text-xl leading-relaxed text-foreground sm:text-2xl">
        <span ref={messageRef} />
        <span className="blinking-cursor" aria-hidden="true">
          |
        </span>
      </p>

      <div className="flex items-center gap-3">
        <div ref={confirmRef} className="rounded-full bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground shadow-[0_0_0_4px] shadow-primary/15">
          Confirm
        </div>
        <div ref={declineRef} className="rounded-full border border-danger/40 bg-danger/10 px-6 py-2 text-sm font-medium text-danger">
          Declined
        </div>
      </div>
    </section>
  );
}
