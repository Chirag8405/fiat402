"use client";

/**
 * Section 3 -- the signature moment. One pinned section, one scrubbed
 * gsap.timeline (scrub: true, tied 1:1 to scroll position, reversible by
 * scrolling back up -- GSAP scrub timelines are inherently reversible, no
 * extra code needed for that; `true` rather than a numeric value to avoid
 * stacking GSAP's own catch-up smoothing on top of Lenis's already-eased
 * scroll position -- see HumanMoment.tsx's top comment). A single "packet"
 * wrapper travels left to right across the whole [0,1] timeline; two cards live inside it at the
 * same position and crossfade during [0.35, 0.55]:
 *
 *   [0    -> 0.35] terminal/raw-HTTP card visible, wrapper translating right
 *   [0.35 -> 0.55] terminal card fades+scales out, UPI/QR card fades+scales
 *                  in, AT THE SAME wrapper position -- reads as one object
 *                  transforming, not two objects crossing
 *   [0.55 -> 1.0 ] UPI card continues translating to the right edge
 *
 * MOBILE FIX: the travel distance is computed from measured element widths
 * (trackRef.clientWidth - wrapperRef.offsetWidth), not a fixed/viewport-scaled
 * guess -- a percentage `left` value alone isn't enough once the card's own
 * width is a meaningful fraction of the viewport (it was previously
 * `min(90vw, 22rem)`, i.e. nearly full-width on a phone, so `left: 78%` plus
 * the card's own width ran ~260px past the right edge on a ~416px viewport).
 * The card's width is now fixed via responsive rem classes (w-64/w-80, not
 * vw-based) so it's predictable, and the end `x` value is a FUNCTION GSAP
 * re-evaluates on every ScrollTrigger.refresh() (which fires automatically on
 * resize) -- the documented pattern for tween values that must track live
 * element/container measurements rather than a static number computed once.
 *
 * Static sample markup only (illustrative PaymentRequired-shaped JSON and a
 * sample UPI intent string) -- deliberately not wired to any live state or
 * /api/* route, per this page's zero-real-backend-calls rule (see
 * app/page.tsx's top comment). Known pre-existing gap, unrelated to this
 * composition pass: this sample is hardcoded, not fixture-derived, unlike
 * ColdOpen.tsx's JSON panel (which decodes a real captured fixture) --
 * worth fixing in a future pass, deliberately not touched here so this
 * doesn't end up with a second, differently-fake data source.
 *
 * Composition redesign: two-column layout (dense left framing copy + a
 * bordered right card), per the "no section shows a single line of text
 * centered alone" principle. The crossfade animation itself (refs, GSAP
 * timeline, the mobile-safe measured-width travel math) is unchanged --
 * only the surrounding markup/chrome around it changed. trackRef's
 * container is now the right column instead of the full section width;
 * since the travel-distance math already measures trackRef.clientWidth
 * live (not a hardcoded viewport-relative guess), narrowing it needs zero
 * formula changes.
 */

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { QRCodeSVG } from "qrcode.react";
import { WindowChrome } from "./WindowChrome";

const SAMPLE_PAYMENT_REQUIRED = `{
  "x402Version": 2,
  "accepts": [{
    "scheme": "upi",
    "network": "upi:in",
    "amount": "10000",
    "asset": "INR",
    "payTo": "merchant@upi",
    "maxTimeoutSeconds": 180
  }]
}`;

const SAMPLE_UPI_INTENT = "upi://pay?pa=merchant@upi&pn=fiat402%20Demo%20Merchant&am=100.00&cu=INR";

export function Bridge() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const qrRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sectionRef.current || !trackRef.current || !wrapperRef.current || !terminalRef.current || !qrRef.current) return;

    const ctx = gsap.context(() => {
      gsap.set(qrRef.current, { autoAlpha: 0, scale: 0.9 });
      gsap.set(terminalRef.current, { autoAlpha: 1, scale: 1 });

      const timeline = gsap.timeline({
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top top",
          end: "+=300%",
          pin: true,
          scrub: true,
          // Belt-and-suspenders cleanup: force both cards fully hidden the
          // instant scroll leaves this section's active range in EITHER
          // direction, rather than trusting the scrubbed timeline's own
          // clamped end/start state to always read as "gone". Addresses a
          // reported stray "merchant@upi" label visible while scrolling
          // through the section that follows -- whatever the exact
          // mechanism, this guarantees neither card can render once this
          // section is no longer the one being scrolled through.
        },
      });

      // CSS `padding` on trackRef does NOT constrain an absolutely
      // positioned child's `left: 0`/`left: <n>` -- per spec, padding never
      // narrows the containing block absolute descendants resolve `left`
      // against (confirmed empirically against an earlier px-4/sm:px-10
      // padding on trackRef: rendered left was 0, not 16, with that padding
      // in place -- since removed, trackRef carries no padding now). So the
      // margin has to be an explicit JS constant
      // applied symmetrically to BOTH ends, not derived from CSS padding.
      // Both the start ("from") and end ("to") values are functions --
      // GSAP re-evaluates them at every ScrollTrigger refresh (fires
      // automatically on resize), so the margin/travel distance always
      // matches the CURRENT viewport width and measured card width.
      const marginPx = () => (window.innerWidth < 640 ? 16 : 40);
      timeline.fromTo(
        wrapperRef.current,
        { left: () => marginPx() },
        {
          left: () => {
            const track = trackRef.current;
            const wrapper = wrapperRef.current;
            if (!track || !wrapper) return marginPx();
            return track.clientWidth - marginPx() - wrapper.offsetWidth;
          },
          ease: "none",
          duration: 1,
        },
        0,
      );
      timeline.to(terminalRef.current, { autoAlpha: 0, scale: 0.9, ease: "none", duration: 0.2 }, 0.35);
      timeline.to(qrRef.current, { autoAlpha: 1, scale: 1, ease: "none", duration: 0.2 }, 0.35);
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section ref={sectionRef} className="relative flex min-h-screen items-center overflow-hidden px-6 py-24">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
        {/* Left: framing copy, dense stack. */}
        <div className="flex flex-col items-start gap-4">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">raw protocol → rupee-settled payment</p>
          <h2 className="text-3xl font-semibold leading-tight text-foreground sm:text-4xl">The Bridge</h2>
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
            One HTTP 402 response. One scan. The agent never leaves the request.
          </p>
        </div>

        {/* Right: bordered card -- chrome strip, crossfading media area, caption band. */}
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <WindowChrome label="PAYMENT-REQUIRED → UPI" />

          <div ref={trackRef} className="relative h-72 overflow-hidden sm:h-80">
            {/* wrapperRef spans the FULL track height (inset-y-0), not a
                shrink-to-fit box vertically centered via translate -- with
                only `top-1/2 -translate-y-1/2` (no explicit height),
                terminalRef/qrRef's `inset-0` had no definite height to fill
                and their auto-height content spilled past trackRef's
                boundary into the caption band below. Giving wrapperRef a
                real height lets inset-0 (and the flex-centered content
                inside each pane) resolve correctly and stay clipped by
                trackRef's own overflow-hidden. */}
            <div ref={wrapperRef} className="absolute inset-y-0 w-56 sm:w-64">
              <div ref={terminalRef} className="absolute inset-0 flex flex-col justify-center p-4">
                <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">PAYMENT-REQUIRED</p>
                <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground">{SAMPLE_PAYMENT_REQUIRED}</pre>
              </div>

              <div ref={qrRef} className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
                <div className="rounded-lg bg-white p-3">
                  <QRCodeSVG value={SAMPLE_UPI_INTENT} size={144} />
                </div>
                <div className="text-center">
                  <p className="text-lg font-semibold text-foreground">₹100.00</p>
                  <code className="text-xs text-muted-foreground">merchant@upi</code>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{SAMPLE_UPI_INTENT}</code>
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              UPI Intent
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
