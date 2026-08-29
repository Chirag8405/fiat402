/**
 * Pure predicate for whether a request is genuinely blocked server-side
 * awaiting a human confirm-gate decision -- see apps/facilitator/src/server.ts's
 * settlePayment (awaitConfirmGate) and apps/facilitator/src/confirm-gate.ts.
 *
 * Both conditions matter: a request can be "pending" with aiRecommendation
 * "approve" (no gate involved, just waiting on the payer), and a past "hold"
 * recommendation is only live-blocking while the request is still "pending"
 * -- once it moves to any other state the gate has already been satisfied
 * (via POST /internal/confirm-gate/:requestId or the payer paying the Payment
 * Link directly, either of which resolves settlePayment's bounded wait) or
 * timed out (ai-hold-timed-out), so showing a Confirm button after that would
 * be either useless or misleading.
 */
export function isPendingHold(state: string | null, aiRecommendation: "approve" | "hold" | undefined | null): boolean {
  return state === "pending" && aiRecommendation === "hold";
}
