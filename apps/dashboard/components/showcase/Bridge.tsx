"use client";

/**
 * Section 3 -- the signature moment. One pinned section, one scrubbed
 * gsap.timeline (scrub: 1, tied 1:1 to scroll position, reversible by
 * scrolling back up -- GSAP scrub timelines are inherently reversible, no
 * extra code needed for that). A single "packet" wrapper travels left to
 * right across the whole [0,1] timeline; two cards live inside it at the
 * same position and crossfade during [0.35, 0.55]:
 *
 *   [0    -> 0.35] terminal/raw-HTTP card visible, wrapper translating right
 *   [0.35 -> 0.55] terminal card fades+scales out, UPI/QR card fades+scales
 *                  in, AT THE SAME wrapper position -- reads as one object
 *                  transforming, not two objects crossing
 *   [0.55 -> 1.0 ] UPI card continues translating to the right edge
 *
 * Static sample markup only (illustrative PaymentRequired-shaped JSON and a
 * sample UPI intent string) -- deliberately not wired to any live state or
 * /api/* route, per this page's zero-real-backend-calls rule (see
 * app/page.tsx's top comment).
 */

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { QRCodeSVG } from "qrcode.react";

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
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const qrRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sectionRef.current || !wrapperRef.current || !terminalRef.current || !qrRef.current) return;

    const ctx = gsap.context(() => {
      gsap.set(qrRef.current, { autoAlpha: 0, scale: 0.9 });
      gsap.set(terminalRef.current, { autoAlpha: 1, scale: 1 });
      gsap.set(wrapperRef.current, { left: "4%" });

      const timeline = gsap.timeline({
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top top",
          end: "+=300%",
          pin: true,
          scrub: 1,
        },
      });

      timeline.to(wrapperRef.current, { left: "78%", ease: "none", duration: 1 }, 0);
      timeline.to(terminalRef.current, { autoAlpha: 0, scale: 0.9, ease: "none", duration: 0.2 }, 0.35);
      timeline.to(qrRef.current, { autoAlpha: 1, scale: 1, ease: "none", duration: 0.2 }, 0.35);
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section ref={sectionRef} className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute left-1/2 top-10 -translate-x-1/2 text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">raw protocol → rupee-settled payment</p>
      </div>

      <div className="relative h-screen">
        <div ref={wrapperRef} className="absolute top-1/2 w-[min(90vw,22rem)] -translate-y-1/2">
          <div ref={terminalRef} className="absolute inset-0 rounded-lg border border-border bg-card p-4 shadow-lg">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-primary">PAYMENT-REQUIRED</p>
            <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground">{SAMPLE_PAYMENT_REQUIRED}</pre>
          </div>

          <div ref={qrRef} className="absolute inset-0 flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-4 shadow-lg">
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
    </section>
  );
}
