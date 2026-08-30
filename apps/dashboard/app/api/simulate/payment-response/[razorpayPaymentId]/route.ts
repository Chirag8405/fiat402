/**
 * GET /api/simulate/payment-response/:razorpayPaymentId -- reads back the
 * PAYMENT-RESPONSE header app/api/simulate/route.ts's deferred `after()`
 * call persisted to Redis on settlement success -- see
 * ../../../../../lib/simulate-payment-response.ts's top comment for why
 * this is keyed by razorpayPaymentId (not requestId) and why it lives in
 * Redis rather than sessionStorage or Postgres.
 *
 * Fetched by app/page.tsx exactly once per terminal request that has a
 * razorpayPaymentId, not polled -- there's nothing to poll for: this either
 * resolves once (the value was written) or never will (settlement failed,
 * so nothing was ever written, or the TTL already expired). A miss/expiry
 * is a normal, expected outcome, not an error -- returns `{
 * paymentResponseHeader: null }`, not a 404.
 */

import { redisClient } from "../../../../../lib/redis";
import { paymentResponseKey } from "../../../../../lib/simulate-payment-response";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ razorpayPaymentId: string }> }): Promise<Response> {
  const { razorpayPaymentId } = await params;
  const paymentResponseHeader = await redisClient.get<string>(paymentResponseKey(razorpayPaymentId));
  return Response.json({ paymentResponseHeader: paymentResponseHeader ?? null });
}
