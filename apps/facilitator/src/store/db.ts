/**
 * Postgres persistence for terminal (settled|failed) reconciliation records.
 *
 * Reads DATABASE_URL from env and constructs one shared pg Pool, mirroring
 * the pattern in ../razorpay/client.ts and ./redis.ts: a single place
 * credentials are read from env. Table schema is
 * ../../migrations/0001_create_reconciliation_records.sql — keep the
 * INSERT column list in writeReconciliationRecord in sync with that file.
 *
 * `writeReconciliationRecord` takes the pg client as its first argument
 * (DI, not a module-level import) so it can be exercised against a fake in
 * tests, matching the pattern already used by
 * ../policy/deterministic.ts's VelocityRedisClient and
 * ../razorpay/webhook-handler.ts's WebhookRedisClient.
 */

import { Pool } from "pg";
import type { AdvisoryRecommendation, AdvisoryProvider } from "../policy/ai-advisory";

/**
 * Minimal Postgres client surface this module needs. `pg`'s `Pool` and
 * `Client` both satisfy this structurally.
 */
export interface PgClient {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

export const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * One row of `reconciliation_records`. Written once a request reaches a
 * terminal outcome (settled|failed) — this is the durable audit trail that
 * outlives the Redis `req:{requestId}:*` keys, which self-expire per
 * CLAUDE.md's TTL rule.
 *
 * Field groups, per this module's spec:
 *   - x402 request identifiers: requestId, txnRef
 *   - Razorpay payment_id: razorpayPaymentId (plus paymentLinkId, since the
 *     payment_id alone doesn't identify which Payment Link produced it)
 *   - deterministic decision + reason: deterministicDecision/deterministicReason,
 *     from apps/facilitator/src/policy/deterministic.ts's DeterministicPolicyResult
 *   - AI recommendation + justification + provider: aiRecommendation/
 *     aiJustification/aiProvider, from ../policy/ai-advisory.ts's AdvisoryResult.
 *     aiJustification is sourced from AdvisoryResult.humanSummary (the
 *     plain-language field for a human reviewer) -- AdvisoryResult no longer
 *     has a `justification` field.
 *   - all state transition timestamps: createdAt/pendingAt/resolvedAt/
 *     settledAt/failedAt, mirroring the state machine's
 *     created -> pending -> approved|declined|expired -> settled|failed
 *   - final outcome: finalOutcome
 */
export interface ReconciliationRecord {
  requestId: string;
  txnRef: string | null;

  razorpayPaymentId: string | null;
  paymentLinkId: string | null;

  amountPaise: string;
  payTo: string;

  deterministicDecision: boolean;
  deterministicReason: string | null;

  aiRecommendation: AdvisoryRecommendation | null;
  aiJustification: string | null;
  aiProvider: AdvisoryProvider | null;

  /** ISO 8601 timestamps, one per state transition; null if that state was never reached. */
  createdAt: string;
  pendingAt: string | null;
  resolvedAt: string | null;
  settledAt: string | null;
  failedAt: string | null;

  finalOutcome: "settled" | "failed";
}

/**
 * Persists a completed request's full reconciliation trail. Never called
 * mid-flight — only once a request has reached a terminal outcome, since
 * `finalOutcome` is required and non-nullable.
 */
export async function writeReconciliationRecord(client: PgClient, record: ReconciliationRecord): Promise<void> {
  await client.query(
    `INSERT INTO reconciliation_records (
       request_id, txn_ref,
       razorpay_payment_id, payment_link_id,
       amount_paise, pay_to,
       deterministic_decision, deterministic_reason,
       ai_recommendation, ai_justification, ai_provider,
       created_at, pending_at, resolved_at, settled_at, failed_at,
       final_outcome
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      record.requestId,
      record.txnRef,
      record.razorpayPaymentId,
      record.paymentLinkId,
      record.amountPaise,
      record.payTo,
      record.deterministicDecision,
      record.deterministicReason,
      record.aiRecommendation,
      record.aiJustification,
      record.aiProvider,
      record.createdAt,
      record.pendingAt,
      record.resolvedAt,
      record.settledAt,
      record.failedAt,
      record.finalOutcome,
    ],
  );
}
