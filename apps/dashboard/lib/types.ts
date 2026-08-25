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
  aiRecommendation?: "approve" | "hold" | "flag";
  aiJustification?: string;
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
