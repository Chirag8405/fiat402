/**
 * `fiat402:events` pub/sub schema, copied verbatim from
 * apps/facilitator/src/ws.ts (the authoritative source, per CLAUDE.md's
 * "Pub/sub event schema" section). Duplicated here rather than imported so
 * this package has zero cross-package imports into apps/facilitator/ --
 * Vercel only installs this package's own node_modules, so a runtime import
 * that reaches into the facilitator app would drag in dependencies (express,
 * cors, razorpay, pg, dotenv) this package doesn't declare and can't build
 * with. Keep in sync with apps/facilitator/src/ws.ts by hand.
 */

export type RequestState = "created" | "pending" | "approved" | "declined" | "expired" | "settled" | "failed";

export interface FiatEvent {
  requestId: string;
  state: RequestState;
  previousState: string | null;
  timestamp: string;
  meta: {
    paymentLinkId: string | null;
    razorpayPaymentId: string | null;
    reason: string | null;
  };
  /**
   * aiRecommendation intentionally keeps the "approve"/"hold" vocabulary
   * ("flag" removed -- dead value, never produced by the facilitator's
   * AdvisoryRecommendation type) -- see apps/facilitator/src/ws.ts's
   * FiatEvent doc comment for why the facilitator's internal "proceed" is
   * translated to "approve" before publishing, and why that's a deliberate,
   * permanent shim rather than a stopgap.
   *
   * aiJustification is kept for this app's existing call sites (DecisionPanel,
   * app/page.tsx); aiHumanSummary carries the same content under the new
   * field name for code migrating off aiJustification. aiReasoning is a
   * separate, technical/log-facing string -- not the same audience as either
   * human-facing field above.
   */
  aiRecommendation?: "approve" | "hold";
  aiSemanticMatch?: boolean;
  aiJustification?: string;
  aiHumanSummary?: string;
  aiReasoning?: string;
  aiProvider?: string;
  deterministicDecision?: "allowed" | "rejected";
  deterministicReason?: string;
}

export const EVENTS_CHANNEL = "fiat402:events";

/**
 * Bounded recent-events list the facilitator LPUSHes onto (and LTRIMs to the
 * most recent 200 entries) alongside every EVENTS_CHANNEL publish -- see
 * apps/facilitator/src/ws.ts's publishEvent. This is what
 * app/api/events/route.ts polls, since a plain pub/sub channel has no
 * history for a reader that wasn't subscribed at publish time.
 */
export const EVENTS_RECENT_LIST = "fiat402:events:recent";

/**
 * Mirrors apps/facilitator/src/store/db.ts's `ReconciliationRecord` --
 * duplicated here for the same reason as `FiatEvent` above (zero
 * cross-package imports into apps/facilitator/). Fetched via
 * app/api/reconciliation/[requestId]/route.ts, which proxies to the
 * facilitator's `GET /reconciliation/:requestId`, once a request has
 * reached a terminal state and the live event stream no longer has its
 * decision-layer data (see app/page.tsx's postgres-fallback effect).
 *
 * `aiRecommendation` here uses the facilitator's actual "hold"|"proceed"
 * vocabulary (unlike `FiatEvent.aiRecommendation` above, which keeps the
 * "approve"|"hold" wire shim for the live-event path) -- writeReconciliationRecord
 * persists `AdvisoryResult.recommendation` directly, with no translation.
 * Code consuming both sources into one shape must translate "proceed" ->
 * "approve" itself; see app/page.tsx's postgres-fallback effect for where
 * that happens.
 */
export interface ReconciliationRecordDto {
  requestId: string;
  txnRef: string | null;
  razorpayPaymentId: string | null;
  paymentLinkId: string | null;
  amountPaise: string;
  payTo: string;
  deterministicDecision: boolean;
  deterministicReason: string | null;
  aiRecommendation: "hold" | "proceed" | null;
  aiJustification: string | null;
  aiProvider: string | null;
  createdAt: string;
  pendingAt: string | null;
  resolvedAt: string | null;
  settledAt: string | null;
  failedAt: string | null;
  finalOutcome: "settled" | "failed";
}
