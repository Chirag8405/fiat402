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
 * timestamp/meta only). Per this module's brief ("the event JSON shape ...
 * is authoritative -- build the UI against that exact shape, do not assume
 * additional fields exist"), app/page.tsx has no live source for these
 * headers and passes `null`s here. This component still implements real
 * decode/pretty-print logic against the three props below, so it is correct
 * and ready the moment a capture path for these headers exists.
 */

import { EmptyState } from "./EmptyState";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { Badge } from "./ui/badge";

export interface RawTrafficViewerProps {
  requestId: string | null;
  paymentRequiredHeader: string | null;
  paymentSignatureHeader: string | null;
  paymentResponseHeader: string | null;
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
          <Badge key={i} variant={scheme === "upi" ? "success" : "outline"}>
            {scheme} / {network}
          </Badge>
        );
      })}
    </div>
  );
}

export function RawTrafficViewer({ requestId, paymentRequiredHeader, paymentSignatureHeader, paymentResponseHeader }: RawTrafficViewerProps) {
  const hasAnything = paymentRequiredHeader || paymentSignatureHeader || paymentResponseHeader;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Raw x402 traffic</CardTitle>
        <CardDescription>{requestId ? `Most recent request: ${requestId}` : "No request observed yet"}</CardDescription>
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
            <HeaderBlock label="PAYMENT-RESPONSE" header={paymentResponseHeader} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
