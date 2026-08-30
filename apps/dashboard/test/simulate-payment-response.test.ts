import { describe, it, expect, vi, beforeEach } from "vitest";
import { paymentResponseKey } from "../lib/simulate-payment-response";

/**
 * Mocks ../lib/redis's redisClient, same approach as test/events.test.ts,
 * so this exercises only the route's key lookup, not a real Redis instance.
 */
const getMock = vi.fn();
vi.mock("../lib/redis", () => ({
  redisClient: { get: (...args: unknown[]) => getMock(...args) },
}));

const { GET } = await import("../app/api/simulate/payment-response/[razorpayPaymentId]/route");

function requestWith(razorpayPaymentId: string): { params: Promise<{ razorpayPaymentId: string }> } {
  return { params: Promise.resolve({ razorpayPaymentId }) };
}

beforeEach(() => {
  getMock.mockReset();
});

describe("GET /api/simulate/payment-response/:razorpayPaymentId", () => {
  it("returns the stored header when present", async () => {
    getMock.mockResolvedValue("base64headervalue");

    const response = await GET(new Request("http://localhost/api/simulate/payment-response/pay_123"), requestWith("pay_123"));
    const body = (await response.json()) as { paymentResponseHeader: string | null };

    expect(getMock).toHaveBeenCalledWith(paymentResponseKey("pay_123"));
    expect(body.paymentResponseHeader).toBe("base64headervalue");
  });

  it("returns null, not an error, when nothing was ever written or the TTL already expired", async () => {
    getMock.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/simulate/payment-response/pay_missing"), requestWith("pay_missing"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { paymentResponseHeader: string | null };
    expect(body.paymentResponseHeader).toBeNull();
  });
});
