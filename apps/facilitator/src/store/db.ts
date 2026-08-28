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

/** Raw shape of one `reconciliation_records` row as `pg` hands it back: snake_case columns, TIMESTAMPTZ columns as native `Date` objects (no type-parser override in this file). */
interface ReconciliationRecordRow {
  request_id: string;
  txn_ref: string | null;
  razorpay_payment_id: string | null;
  payment_link_id: string | null;
  amount_paise: string;
  pay_to: string;
  deterministic_decision: boolean;
  deterministic_reason: string | null;
  ai_recommendation: string | null;
  ai_justification: string | null;
  ai_provider: string | null;
  created_at: Date | string;
  pending_at: Date | string | null;
  resolved_at: Date | string | null;
  settled_at: Date | string | null;
  failed_at: Date | string | null;
  final_outcome: "settled" | "failed";
}

/** `ReconciliationRecord`'s timestamp fields are `string` (ISO 8601); `pg` hands back `Date` objects by default. Passes a string through unchanged (e.g. test fakes that already return strings). */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/**
 * Reads the most recent reconciliation record for `requestId`, or `null` if
 * none exists yet (the request hasn't reached a terminal outcome, or
 * `requestId` is unknown). Uses `reconciliation_records_request_id_idx`
 * (../../migrations/0001_create_reconciliation_records.sql).
 *
 * `ORDER BY inserted_at DESC LIMIT 1` defensively picks the latest row: two
 * concurrent /settle calls for the same requestId aren't de-duplicated past
 * Payment Link creation (see settlePayment's idempotency step), so more
 * than one row can in rare cases exist per requestId -- this is an existing,
 * out-of-scope behavior, not something this function fixes.
 */
export async function readReconciliationRecord(client: PgClient, requestId: string): Promise<ReconciliationRecord | null> {
  const result = (await client.query(
    `SELECT
       request_id, txn_ref,
       razorpay_payment_id, payment_link_id,
       amount_paise, pay_to,
       deterministic_decision, deterministic_reason,
       ai_recommendation, ai_justification, ai_provider,
       created_at, pending_at, resolved_at, settled_at, failed_at,
       final_outcome
     FROM reconciliation_records
     WHERE request_id = $1
     ORDER BY inserted_at DESC
     LIMIT 1`,
    [requestId],
  )) as { rows: ReconciliationRecordRow[] };

  const row = result.rows[0];
  if (!row) return null;

  return {
    requestId: row.request_id,
    txnRef: row.txn_ref,
    razorpayPaymentId: row.razorpay_payment_id,
    paymentLinkId: row.payment_link_id,
    amountPaise: row.amount_paise,
    payTo: row.pay_to,
    deterministicDecision: row.deterministic_decision,
    deterministicReason: row.deterministic_reason,
    aiRecommendation: row.ai_recommendation as AdvisoryRecommendation | null,
    aiJustification: row.ai_justification,
    aiProvider: row.ai_provider as AdvisoryProvider | null,
    createdAt: toIso(row.created_at),
    pendingAt: toIsoOrNull(row.pending_at),
    resolvedAt: toIsoOrNull(row.resolved_at),
    settledAt: toIsoOrNull(row.settled_at),
    failedAt: toIsoOrNull(row.failed_at),
    finalOutcome: row.final_outcome,
  };
}
