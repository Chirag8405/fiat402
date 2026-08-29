"use client";

/**
 * Final record for a terminal (settled|failed) request: x402 request ID,
 * Razorpay payment_id, deterministic decision, AI recommendation, final
 * outcome, all timestamps -- mirroring the shape of
 * apps/facilitator/src/store/db.ts's ReconciliationRecord (the row written
 * once a request reaches settled|failed).
 *
 * That full row lives in Postgres, written by writeReconciliationRecord --
 * it is not published to `fiat402:events`. What IS derivable purely from
 * the live event stream is: requestId, razorpayPaymentId and paymentLinkId
 * (from meta), the final outcome (the terminal state itself), a timestamp
 * per transition actually observed live (built up client-side in
 * app/page.tsx as events arrive -- these are real, not fabricated, since
 * they're just the `timestamp` field off each real event for this request),
 * and -- for any request that reached "pending" -- deterministicDecision/
 * deterministicReason and aiRecommendation (see apps/facilitator/src/ws.ts's
 * FiatEvent, which now carries these on the "pending" transition event).
 *
 * `txnRef`/`amountPaise`/`payTo` were never derivable from the live stream
 * at all (no FiatEvent field carries them) -- `extras` below is populated
 * from app/page.tsx's Postgres-fallback fetch (GET
 * /api/reconciliation/:requestId, once a request is terminal), the same
 * fetch that backfills `deterministic`/`ai` when the "pending" event has
 * scrolled out of fiat402:events:recent's bounded window. Still renders as
 * "not available on the live event stream" until/unless that fetch
 * resolves -- never guessed at.
 */

import { EmptyState } from "./EmptyState";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";
import type { DeterministicDecision, AiAdvisory } from "./DecisionPanel";

export interface ObservedTimestamps {
  pendingAt: string | null;
  resolvedAt: string | null;
  settledAt: string | null;
  failedAt: string | null;
}

/** Fields no FiatEvent carries -- only ever available via the Postgres fallback fetch, never the live stream. See this file's top-of-file comment. */
export interface ReconciliationExtras {
  txnRef: string | null;
  amountPaise: string | null;
  payTo: string | null;
}

export interface ReconciliationRecordProps {
  requestId: string | null;
  finalOutcome: "settled" | "failed" | null;
  razorpayPaymentId: string | null;
  paymentLinkId: string | null;
  timestamps: ObservedTimestamps;
  deterministic: DeterministicDecision | null;
  ai: AiAdvisory | null;
  extras: ReconciliationExtras;
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("text-xs text-foreground", mono && "font-mono")}>
        {value ?? <span className="text-muted-foreground">not available on the live event stream</span>}
      </span>
    </div>
  );
}

export function ReconciliationRecord({
  requestId,
  finalOutcome,
  razorpayPaymentId,
  paymentLinkId,
  timestamps,
  deterministic,
  ai,
  extras,
}: ReconciliationRecordProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reconciliation record</CardTitle>
        <CardDescription>Written once a request reaches settled or failed</CardDescription>
      </CardHeader>
      <CardContent>
        {!finalOutcome ? (
          <EmptyState>Awaiting a terminal (settled|failed) outcome for the current request&hellip;</EmptyState>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field mono label="Request ID" value={<span className="break-all">{requestId}</span>} />
            <Field label="Final outcome" value={<Badge variant={finalOutcome === "settled" ? "success" : "danger"}>{finalOutcome}</Badge>} />
            <Field mono label="Razorpay payment_id" value={razorpayPaymentId && <span className="break-all">{razorpayPaymentId}</span>} />
            <Field mono label="Payment Link" value={paymentLinkId && <span className="break-all">{paymentLinkId}</span>} />
            <Field label="Deterministic decision" value={deterministic ? (deterministic.allowed ? "allowed" : "rejected") : null} />
            <Field label="AI recommendation" value={ai?.recommendation} />
            <Field mono label="Transaction ref" value={extras.txnRef && <span className="break-all">{extras.txnRef}</span>} />
            <Field mono label="Amount (paise)" value={extras.amountPaise} />
            <Field mono label="Pay to" value={extras.payTo && <span className="break-all">{extras.payTo}</span>} />
            <Field label="Pending at" value={timestamps.pendingAt} />
            <Field label="Resolved at" value={timestamps.resolvedAt} />
            <Field label="Settled at" value={timestamps.settledAt} />
            <Field label="Failed at" value={timestamps.failedAt} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
