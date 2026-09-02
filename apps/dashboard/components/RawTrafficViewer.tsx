"use client";

/**
 * Decodes and pretty-prints the base64 `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE`
 * / `PAYMENT-RESPONSE` headers (x402-specification-v2.md section 5.1/5.3,
 * transports-v2/http.md) for the most recent request.
 *
 * These headers travel over plain HTTP between the client and the merchant
 * resource server (apps/merchant) -- they are never published to the
 * `fiat402:events` Redis channel this dashboard's SSE relay subscribes to
 * (see apps/facilitator/src/ws.ts's FiatEvent: requestId/state/previousState/
 * timestamp/meta only), so there is no general-purpose capture path for them.
 *
 * SCOPE LIMIT: `paymentRequiredHeader`/`paymentSignatureHeader` are only ever
 * populated for a dashboard-triggered Simulate Agent run -- see
 * app/api/simulate/route.ts's top-of-file comment for exactly how (and why)
 * that one route can capture/construct them in-process. A request from
 * x402-upi-client/test/demo.ts (run from a terminal) or from a real agent
 * hitting the merchant's x402-middleware.ts directly has no capture path at
 * all and will still show the plain "not observed" empty state below,
 * exactly as before this feature existed.
 *
 * `paymentResponseHeader`: captured too, once available -- see
 * app/api/simulate/route.ts's `runPaymentFlow` and
 * lib/simulate-payment-response.ts for how it's persisted (Redis, keyed by
 * razorpayPaymentId -- requestId is never knowable, even server-side) and
 * app/page.tsx for the one-shot fetch that retrieves it once the request
 * reaches a terminal state. Since that fetch only resolves after settlement
 * concludes, `paymentResponsePending` is passed in explicitly (page.tsx
 * knows `finalOutcome`, which this component doesn't) rather than derived
 * from the other two headers' presence alone -- the earlier version of this
 * component conflated "no header yet" with "still pending," which read as
 * stuck once settlement had already failed (no PAYMENT-RESPONSE is ever
 * sent by the merchant on a failed settlement) or once a successful one's
 * value had aged out of Redis (10-minute TTL).
 */

import { EmptyState } from "./EmptyState";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { Badge } from "./ui/badge";

export interface RawTrafficViewerProps {
  requestId: string | null;
  paymentRequiredHeader: string | null;
  paymentSignatureHeader: string | null;
  paymentResponseHeader: string | null;
  /** True only while settlement is still genuinely in flight (no terminal state yet) for a request that has captured headers -- see this file's top comment. */
  paymentResponsePending: boolean;
}

type DecodeResult = { ok: true; json: unknown } | { ok: false; error: string };

/**
 * `atob`/`TextDecoder`, not `Buffer` -- this is a "use client" component, and
 * `Buffer` isn't available in the browser bundle without a polyfill Next.js
 * doesn't add by default. Both `atob` and `TextDecoder` are standard globals
 * in browsers and in Node 18+, so this works identically during SSR and
 * after hydration.
 */
function decodeBase64Header(header: string): DecodeResult {
  try {
    const binary = atob(header);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const decoded = new TextDecoder("utf-8").decode(bytes);
    return { ok: true, json: JSON.parse(decoded) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function HeaderBlock({ label, header }: { label: string; header: string | null }) {
  if (!header) {
    return (
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
        <EmptyState>not observed for this request</EmptyState>
      </div>
    );
  }

  const result = decodeBase64Header(header);

  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      {result.ok ? (
        <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-[11px] leading-relaxed text-foreground">
          {JSON.stringify(result.json, null, 2)}
        </pre>
      ) : (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-[11px] text-danger">
          Failed to decode: {result.error}
        </div>
      )}
    </div>
  );
}

/** Renders each `accepts[]` entry's scheme/network so a upi entry alongside any crypto scheme is visible at a glance. */
function AcceptsSchemes({ header }: { header: string | null }) {
  if (!header) return null;
  const result = decodeBase64Header(header);
  if (!result.ok) return null;
  const accepts = (result.json as { accepts?: unknown }).accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {accepts.map((rawEntry, i) => {
        const entry = rawEntry as { scheme?: unknown; network?: unknown };
        const scheme = typeof entry?.scheme === "string" ? entry.scheme : "unknown";
        const network = typeof entry?.network === "string" ? entry.network : "unknown";
        return (
          <Badge key={i} mono variant={scheme === "upi" ? "success" : "outline"}>
            {scheme} / {network}
          </Badge>
        );
      })}
    </div>
  );
}

export function RawTrafficViewer({
  requestId,
  paymentRequiredHeader,
  paymentSignatureHeader,
  paymentResponseHeader,
  paymentResponsePending,
}: RawTrafficViewerProps) {
  const hasAnything = paymentRequiredHeader || paymentSignatureHeader || paymentResponseHeader;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Raw x402 traffic</CardTitle>
        <CardDescription>
          {requestId ? (
            <>
              Most recent request: <span className="font-mono">{requestId}</span>
            </>
          ) : (
            "No request observed yet"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasAnything ? (
          <EmptyState>
            No PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers observed on the live feed. This panel decodes those
            HTTP headers; the dashboard&apos;s live feed is the Redis event channel, which doesn&apos;t carry them.
          </EmptyState>
        ) : (
          <>
            <AcceptsSchemes header={paymentRequiredHeader} />
            <HeaderBlock label="PAYMENT-REQUIRED" header={paymentRequiredHeader} />
            <HeaderBlock label="PAYMENT-SIGNATURE" header={paymentSignatureHeader} />
            {!paymentResponseHeader && paymentResponsePending ? (
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">PAYMENT-RESPONSE</div>
                <EmptyState>pending -- awaiting settlement (runs in the background, up to 180s)</EmptyState>
              </div>
            ) : (
              <HeaderBlock label="PAYMENT-RESPONSE" header={paymentResponseHeader} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
