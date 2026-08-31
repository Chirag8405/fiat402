"use client";

/**
 * Section 1 -- full-bleed HTTP 402, terminal-style. No ScrollTrigger here
 * (nothing to scrub yet -- this is the resting frame before scroll starts),
 * just a CSS blink on the cursor (see globals.css's .blinking-cursor,
 * respects prefers-reduced-motion like this file's other looping animations).
 */
export function ColdOpen() {
  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center gap-8 overflow-hidden px-6 text-center">
      <span className="font-mono text-[13rem] font-bold leading-none tracking-tighter text-primary sm:text-[16rem]">402</span>
      <p className="max-w-xl font-mono text-sm leading-relaxed text-muted-foreground sm:text-base">
        The internet has had a payment status code since 1997.
        <br />
        Nobody used it until agents needed to
        <span className="blinking-cursor" aria-hidden="true">
          _
        </span>
      </p>
      <div className="absolute bottom-10 flex flex-col items-center gap-1.5 text-[11px] uppercase tracking-widest text-muted-foreground">
        <span>scroll</span>
        <span className="h-6 w-px bg-border" />
      </div>
    </section>
  );
}
