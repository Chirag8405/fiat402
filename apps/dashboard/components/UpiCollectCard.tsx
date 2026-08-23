"use client";

/**
 * Shows the Razorpay Payment Link the moment a request enters "pending"
 * state. Per this module's brief: the value comes from the event's
 * `meta.paymentLinkId` and only from there -- it is NOT re-derived (no
 * Razorpay API call, no reconstructed short_url). Real Payment Links do
 * have a separate `short_url` (see apps/facilitator/src/razorpay/payment-links.ts's
 * `shortUrl`), but that value is never written into the `req:{requestId}:*`
 * Redis keys or the FiatEvent published on `fiat402:events` (only
 * `paymentLinkId`, the Razorpay `payment_link_id`, is) -- so it is not
 * available to this dashboard, which only observes the pub/sub channel.
 */

import { QRCodeSVG } from "qrcode.react";
import { EmptyState } from "./EmptyState";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { Badge } from "./ui/badge";
import type { RequestState } from "../lib/events";

export interface UpiCollectCardProps {
  requestId: string | null;
  state: RequestState | null;
  paymentLinkId: string | null;
}

export function UpiCollectCard({ requestId, state, paymentLinkId }: UpiCollectCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>UPI collect</CardTitle>
        <CardDescription>{requestId ? `Request: ${requestId}` : "No request in flight"}</CardDescription>
      </CardHeader>
      <CardContent>
        {!paymentLinkId ? (
          <EmptyState>Waiting for a request to enter &quot;pending&quot; (Payment Link created)&hellip;</EmptyState>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-lg bg-white p-3">
              <QRCodeSVG value={paymentLinkId} size={176} />
            </div>
            <div className="flex flex-col items-center gap-1">
              <Badge variant={state === "settled" ? "success" : state === "failed" ? "danger" : "warning"}>{state ?? "pending"}</Badge>
              <code className="max-w-full break-all text-center text-xs text-muted-foreground">{paymentLinkId}</code>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
