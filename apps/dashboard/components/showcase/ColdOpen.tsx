"use client";

/**
 * Section 1 -- full-bleed HTTP 402, terminal-style. No ScrollTrigger here
 * (nothing to scrub yet -- this is the resting frame before scroll starts),
 * just a CSS blink on the cursor (see globals.css's .blinking-cursor,
 * respects prefers-reduced-motion like this file's other looping animations).
 *
 * Composition redesign: two-column layout (dense left stack + a bordered
 * right panel), per the "no section shows a single line of text centered
 * alone" principle. The right panel's JSON preview is REAL captured data --
 * fixtures/researchbot-clean-approve.json's headers.paymentRequiredHeader
 * (base64), decoded locally below with the same technique
 * components/showcase-r3f/BridgeZone.tsx used in the (now removed) R3F
 * pass. lib/replay-fixtures.ts's own decodeBase64Json is private/unexported,
 * so this stays a local equivalent rather than a shared import.
 * getFixture("researchbot") is the same fixture LiveProof's default
 * auto-run uses. Bridge.tsx's OWN PAYMENT-REQUIRED card is still a static
 * hardcoded sample (pre-existing, flagged as a known gap, not touched
 * here) -- deliberately not reused as this panel's data source so this
 * doesn't compound that gap with a second fake source.
 */

import { WindowChrome } from "./WindowChrome";
import { getFixture } from "../../lib/replay-fixtures";

interface PaymentRequired {
  x402Version: number;
  accepts: [{ scheme: string; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number }];
}

function decodeBase64Json(header: string): unknown {
  const binary = atob(header);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

const RESEARCHBOT_FIXTURE = getFixture("researchbot");
const PAYMENT_REQUIRED = RESEARCHBOT_FIXTURE.headers.paymentRequiredHeader
  ? (decodeBase64Json(RESEARCHBOT_FIXTURE.headers.paymentRequiredHeader) as PaymentRequired)
  : null;
const ACCEPTED = PAYMENT_REQUIRED?.accepts[0] ?? null;

const JSON_PREVIEW = PAYMENT_REQUIRED
  ? JSON.stringify(
      {
        x402Version: PAYMENT_REQUIRED.x402Version,
        accepts: [
          {
            scheme: ACCEPTED!.scheme,
            network: ACCEPTED!.network,
            amount: ACCEPTED!.amount,
            asset: ACCEPTED!.asset,
            payTo: ACCEPTED!.payTo,
            maxTimeoutSeconds: ACCEPTED!.maxTimeoutSeconds,
          },
        ],
      },
      null,
      2,
    )
  : null;

const META_FACTS = [
  { label: `scheme: ${ACCEPTED?.scheme ?? "upi"}` },
  { label: `network: ${ACCEPTED?.network ?? "upi:in"}` },
  { label: "settled via Razorpay" },
];

export function ColdOpen() {
  return (
    <section className="relative flex min-h-screen items-center overflow-hidden px-6 py-24">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
        {/* Left: dense stack -- eyebrow, headline, subcopy, real-protocol meta row. */}
        <div className="flex flex-col items-start gap-6">
          <span className="rounded-full border border-border px-3 py-1 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            HTTP 402 · Payment Required
          </span>

          <span className="text-7xl font-semibold leading-none tracking-tighter text-primary sm:text-8xl lg:text-9xl">402</span>

          <p className="max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
            The internet has had a payment status code since 1997.
            <br />
            Nobody used it until agents needed to
            <span className="blinking-cursor" aria-hidden="true">
              _
            </span>
          </p>

          <div className="flex w-full flex-wrap gap-x-6 gap-y-2 border-t border-border pt-5">
            {META_FACTS.map(fact => (
              <div key={fact.label} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                <span className="font-mono text-xs text-muted-foreground">{fact.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: bordered panel, chrome strip, real decoded PAYMENT-REQUIRED JSON. */}
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <WindowChrome label="PAYMENT-REQUIRED" />
          <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-foreground">
            {JSON_PREVIEW ?? "// payment-required header unavailable"}
          </pre>
        </div>
      </div>

      <div className="absolute bottom-10 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5 text-[11px] uppercase tracking-widest text-muted-foreground">
        <span>scroll</span>
        <span className="h-6 w-px bg-border" />
      </div>
    </section>
  );
}
