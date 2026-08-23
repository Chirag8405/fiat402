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
 * the live event stream (per this module's brief to build against that
 * exact schema) is: requestId, razorpayPaymentId and paymentLinkId (from
 * meta), the final outcome (the terminal state itself), and a timestamp per
 * transition actually observed live (built up client-side in app/page.tsx
 * as events arrive -- these are real, not fabricated, since they're just
 * the `timestamp` field off each real event for this request). Fields this
 * dashboard cannot see live (deterministicDecision/deterministicReason,
 * aiRecommendation/aiJustification/aiProvider, txnRef, amountPaise, payTo)
 * are rendered as "not available on the live event stream" rather than
 * guessed at.
 */

import { EmptyState } from "./EmptyState";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { Badge } from "./ui/badge";
import type { DeterministicDecision, AiAdvisory } from "./DecisionPanel";

export interface ObservedTimestamps {
  pendingAt: string | null;
  resolvedAt: string | null;
  settledAt: string | null;
  failedAt: string | null;
}

export interface ReconciliationRecordProps {
  requestId: string | null;
  finalOutcome: "settled" | "failed" | null;
  razorpayPaymentId: string | null;
  paymentLinkId: string | null;
  timestamps: ObservedTimestamps;
  deterministic: DeterministicDecision | null;
  ai: AiAdvisory | null;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground">{value ?? <span className="text-muted-foreground">not available on the live event stream</span>}</span>
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
            <Field label="Request ID" value={<code className="break-all">{requestId}</code>} />
            <Field label="Final outcome" value={<Badge variant={finalOutcome === "settled" ? "success" : "danger"}>{finalOutcome}</Badge>} />
            <Field label="Razorpay payment_id" value={razorpayPaymentId && <code className="break-all">{razorpayPaymentId}</code>} />
            <Field label="Payment Link" value={paymentLinkId && <code className="break-all">{paymentLinkId}</code>} />
            <Field label="Deterministic decision" value={deterministic ? (deterministic.allowed ? "allowed" : "rejected") : null} />
            <Field label="AI recommendation" value={ai?.recommendation} />
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
