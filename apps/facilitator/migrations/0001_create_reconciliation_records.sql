-- Reconciliation records: the terminal (settled|failed) audit trail for
-- every x402 upi settlement request. Written once, by
-- apps/facilitator/src/store/db.ts's writeReconciliationRecord, when a
-- request reaches a terminal outcome. See that file's top-of-file comment
-- for field-by-field rationale.

CREATE TABLE IF NOT EXISTS reconciliation_records (
  id                      BIGSERIAL PRIMARY KEY,

  -- x402 request identifiers
  request_id              TEXT NOT NULL,
  txn_ref                 TEXT,

  -- Razorpay identifiers
  razorpay_payment_id     TEXT,
  payment_link_id         TEXT,

  -- Request terms, for audit purposes independent of req:{requestId}:meta's Redis TTL
  amount_paise            TEXT NOT NULL,
  pay_to                  TEXT NOT NULL,

  -- Deterministic policy engine outcome (apps/facilitator/src/policy/deterministic.ts)
  deterministic_decision  BOOLEAN NOT NULL,
  deterministic_reason    TEXT,

  -- AI advisory outcome (apps/facilitator/src/policy/ai-advisory.ts)
  ai_recommendation       TEXT,
  ai_justification        TEXT,
  ai_provider             TEXT,

  -- State transition timestamps (state machine: created -> pending -> approved|declined|expired -> settled|failed)
  created_at              TIMESTAMPTZ NOT NULL,
  pending_at              TIMESTAMPTZ,
  resolved_at             TIMESTAMPTZ,
  settled_at              TIMESTAMPTZ,
  failed_at               TIMESTAMPTZ,

  -- Terminal outcome
  final_outcome           TEXT NOT NULL CHECK (final_outcome IN ('settled', 'failed')),

  inserted_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reconciliation_records_request_id_idx ON reconciliation_records (request_id);
CREATE INDEX IF NOT EXISTS reconciliation_records_razorpay_payment_id_idx ON reconciliation_records (razorpay_payment_id);
