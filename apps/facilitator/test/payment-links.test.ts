import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();

vi.mock("../src/razorpay/client", () => ({
  razorpayClient: {
    paymentLink: {
      create: createMock,
    },
  },
}));

// Imported after the mock so payment-links.ts picks up the mocked client.
const { createUpiPaymentLink } = await import("../src/razorpay/payment-links");

beforeEach(() => {
  createMock.mockReset();
});

describe("createUpiPaymentLink", () => {
  it("calls the Payment Links API with the exact fields CLAUDE.md specifies and returns a success result", async () => {
    createMock.mockResolvedValue({
      id: "plink_QflcnnZqCekuvL",
      short_url: "https://rzp.io/i/AiGGmnh",
    });

    const result = await createUpiPaymentLink(10000, "One cup of chai", 1_700_000_090);

    expect(createMock).toHaveBeenCalledWith({
      upi_link: true,
      amount: 10000,
      currency: "INR",
      description: "One cup of chai",
      expire_by: 1_700_000_090,
      customer: {},
    });
    expect(result).toEqual({
      ok: true,
      paymentLinkId: "plink_QflcnnZqCekuvL",
      shortUrl: "https://rzp.io/i/AiGGmnh",
    });
  });

  it("returns a typed error result (not a thrown exception) on a Razorpay API error", async () => {
    createMock.mockRejectedValue({
      statusCode: 400,
      error: { code: "BAD_REQUEST_ERROR", description: "amount: cannot be blank" },
    });

    const result = await createUpiPaymentLink(10000, "One cup of chai", 1_700_000_090);

    expect(result).toEqual({
      ok: false,
      errorCode: "BAD_REQUEST_ERROR",
      errorDescription: "amount: cannot be blank",
    });
  });

  it("returns a typed error result (not a thrown exception) on a network-level failure", async () => {
    createMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await createUpiPaymentLink(10000, "One cup of chai", 1_700_000_090);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBeNull();
      expect(result.errorDescription).toMatch(/connect ECONNREFUSED/);
    }
  });

  it("rejects a non-positive/non-integer amount before calling the API", async () => {
    const result = await createUpiPaymentLink(0, "desc", 1_700_000_090);

    expect(result).toEqual({ ok: false, errorCode: null, errorDescription: "amountPaise must be a positive integer" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a non-positive expiry timestamp before calling the API", async () => {
    const result = await createUpiPaymentLink(10000, "desc", -1);

    expect(result).toEqual({
      ok: false,
      errorCode: null,
      errorDescription: "expiryUnixTs must be a positive unix timestamp",
    });
    expect(createMock).not.toHaveBeenCalled();
  });
});
