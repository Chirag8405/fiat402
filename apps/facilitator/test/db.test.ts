import { describe, it, expect } from "vitest";
import { readReconciliationRecord, type PgClient } from "../src/store/db";

/** Fake PgClient returning a fixed set of rows regardless of the query text, matching the raw snake_case/Date shape `pg` hands back. */
function fakePg(rows: unknown[]): PgClient {
  return {
    query: async () => ({ rows }),
  };
}

const FULL_ROW = {
  request_id: "req_abc123",
  txn_ref: "txn_1",
  razorpay_payment_id: "pay_xyz",
  payment_link_id: "plink_xyz",
  amount_paise: "10000",
  pay_to: "merchant@ybl",
  deterministic_decision: true,
  deterministic_reason: null,
  ai_recommendation: "proceed",
  ai_justification: "Looks routine.",
  ai_provider: "gemini",
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  pending_at: new Date("2026-01-01T00:00:01.000Z"),
  resolved_at: new Date("2026-01-01T00:00:05.000Z"),
  settled_at: new Date("2026-01-01T00:00:06.000Z"),
  failed_at: null,
  final_outcome: "settled" as const,
};

describe("readReconciliationRecord", () => {
  it("returns null when no row exists for the requestId", async () => {
    const result = await readReconciliationRecord(fakePg([]), "req_unknown");
    expect(result).toBeNull();
  });

  it("maps a full row's snake_case columns and Date timestamps into a ReconciliationRecord", async () => {
    const result = await readReconciliationRecord(fakePg([FULL_ROW]), "req_abc123");

    expect(result).toEqual({
      requestId: "req_abc123",
      txnRef: "txn_1",
      razorpayPaymentId: "pay_xyz",
      paymentLinkId: "plink_xyz",
      amountPaise: "10000",
      payTo: "merchant@ybl",
      deterministicDecision: true,
      deterministicReason: null,
      aiRecommendation: "proceed",
      aiJustification: "Looks routine.",
      aiProvider: "gemini",
      createdAt: "2026-01-01T00:00:00.000Z",
      pendingAt: "2026-01-01T00:00:01.000Z",
      resolvedAt: "2026-01-01T00:00:05.000Z",
      settledAt: "2026-01-01T00:00:06.000Z",
      failedAt: null,
      finalOutcome: "settled",
    });
  });

  it("passes through an already-ISO-string timestamp unchanged (e.g. a test fake that doesn't return Date objects)", async () => {
    const result = await readReconciliationRecord(
      fakePg([{ ...FULL_ROW, created_at: "2026-01-01T00:00:00.000Z" }]),
      "req_abc123",
    );

    expect(result?.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("handles a failed/declined row with null settledAt and a non-null failedAt", async () => {
    const result = await readReconciliationRecord(
      fakePg([
        {
          ...FULL_ROW,
          settled_at: null,
          failed_at: new Date("2026-01-01T00:00:10.000Z"),
          final_outcome: "failed",
        },
      ]),
      "req_abc123",
    );

    expect(result?.settledAt).toBeNull();
    expect(result?.failedAt).toBe("2026-01-01T00:00:10.000Z");
    expect(result?.finalOutcome).toBe("failed");
  });
});
