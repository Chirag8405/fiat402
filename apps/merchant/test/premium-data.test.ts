import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";

/**
 * Mocks the global `fetch` that ../lib/x402-middleware.ts's callFacilitator
 * uses to reach the deployed facilitator's HTTP /verify and /settle
 * endpoints, so these tests exercise only the merchant's own 402/200
 * wiring, not the real deterministic policy / AI advisory / Razorpay /
 * Redis stack apps/facilitator/test/server.test.ts already covers.
 */
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function mockFacilitatorResponses(verifyBody: unknown, settleBody?: unknown): void {
  fetchMock.mockImplementation((url: string) => {
    const body = url.endsWith("/verify") ? verifyBody : settleBody;
    return Promise.resolve({ json: () => Promise.resolve(body) });
  });
}

const { GET } = await import("../app/api/premium-data/route");

const MERCHANT_VPA = "merchant@ybl";
const MERCHANT_NAME = "fiat402 Demo Merchant";
const RESOURCE_PRICE_PAISE = "10000";

function decodeHeader<T>(response: Response, name: string): T {
  const raw = response.headers.get(name);
  expect(raw).toBeTruthy();
  return JSON.parse(Buffer.from(raw as string, "base64").toString("utf-8")) as T;
}

function validPaymentPayload() {
  return {
    x402Version: 2,
    accepted: {
      scheme: "upi",
      network: "upi:in",
      amount: RESOURCE_PRICE_PAISE,
      asset: "INR",
      payTo: MERCHANT_VPA,
      maxTimeoutSeconds: 90,
      extra: { merchantName: MERCHANT_NAME, description: "Premium data access" },
    },
    payload: { txnRef: "txn_test_1" },
  };
}

function requestWithSignature(signatureHeader?: string): Request {
  return new Request("http://localhost/api/premium-data", {
    headers: signatureHeader ? { "PAYMENT-SIGNATURE": signatureHeader } : {},
  });
}

beforeEach(() => {
  vi.stubEnv("MERCHANT_VPA", MERCHANT_VPA);
  vi.stubEnv("MERCHANT_NAME", MERCHANT_NAME);
  vi.stubEnv("RESOURCE_PRICE_PAISE", RESOURCE_PRICE_PAISE);
  vi.stubEnv("FACILITATOR_URL", "http://facilitator.test");
  fetchMock.mockReset();
});

describe("GET /api/premium-data — no PAYMENT-SIGNATURE header", () => {
  it("returns 402 with a spec-shaped PAYMENT-REQUIRED header including the upi accepts entry", async () => {
    const response = await GET(requestWithSignature());
    expect(response.status).toBe(402);

    const challenge = decodeHeader<{
      x402Version: number;
      error?: string;
      resource: { url: string };
      accepts: PaymentRequirements[];
      extensions: Record<string, unknown>;
    }>(response, "PAYMENT-REQUIRED");

    expect(challenge.x402Version).toBe(2);
    expect(challenge.error).toBeTruthy();
    expect(challenge.resource).toBeTruthy();
    expect(challenge.extensions).toEqual({});
    expect(challenge.accepts).toContainEqual({
      scheme: "upi",
      network: "upi:in",
      amount: RESOURCE_PRICE_PAISE,
      asset: "INR",
      payTo: MERCHANT_VPA,
      maxTimeoutSeconds: 90,
      extra: { merchantName: MERCHANT_NAME, description: "Premium data access" },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/premium-data — malformed PAYMENT-SIGNATURE", () => {
  it("returns 402 with PaymentRequired.error set for a non-base64 header, not a 500", async () => {
    const response = await GET(requestWithSignature("not-valid-base64!!!"));
    expect(response.status).toBe(402);

    const challenge = decodeHeader<{ error?: string }>(response, "PAYMENT-REQUIRED");
    expect(typeof challenge.error).toBe("string");
    expect(challenge.error?.length).toBeGreaterThan(0);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 402 with PaymentRequired.error set when base64 decodes to non-JSON, not a 500", async () => {
    const header = Buffer.from("this is not json", "utf-8").toString("base64");
    const response = await GET(requestWithSignature(header));
    expect(response.status).toBe(402);

    const challenge = decodeHeader<{ error?: string }>(response, "PAYMENT-REQUIRED");
    expect(typeof challenge.error).toBe("string");
    expect(challenge.error?.length).toBeGreaterThan(0);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/premium-data — facilitator verify rejects", () => {
  it("returns 402 with invalidReason in the body when /verify returns isValid: false", async () => {
    mockFacilitatorResponses({ isValid: false, invalidReason: "amount exceeds MAX_AMOUNT_PAISE" });

    const header = Buffer.from(JSON.stringify(validPaymentPayload()), "utf-8").toString("base64");
    const response = await GET(requestWithSignature(header));

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.invalidReason).toBe("amount exceeds MAX_AMOUNT_PAISE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/premium-data — facilitator settle fails", () => {
  it("returns 402, not 200, with errorReason in the body when /settle returns success: false", async () => {
    mockFacilitatorResponses(
      { isValid: true },
      {
        success: false,
        errorReason: "payment-declined",
        transaction: "",
        network: "upi:in",
      },
    );

    const header = Buffer.from(JSON.stringify(validPaymentPayload()), "utf-8").toString("base64");
    const response = await GET(requestWithSignature(header));

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.errorReason).toBe("payment-declined");
  });
});

describe("GET /api/premium-data — facilitator settle succeeds", () => {
  it("returns 200, the resource JSON, and a spec-shaped PAYMENT-RESPONSE header", async () => {
    mockFacilitatorResponses(
      { isValid: true },
      {
        success: true,
        transaction: "pay_Qfldmt5StKZFCB",
        network: "upi:in",
        amount: RESOURCE_PRICE_PAISE,
      },
    );

    const header = Buffer.from(JSON.stringify(validPaymentPayload()), "utf-8").toString("base64");
    const response = await GET(requestWithSignature(header));

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data).toBeTruthy();

    const settlement = decodeHeader<{ success: boolean; transaction: string; network: string; amount?: string }>(
      response,
      "PAYMENT-RESPONSE",
    );
    expect(settlement).toEqual({
      success: true,
      transaction: "pay_Qfldmt5StKZFCB",
      network: "upi:in",
      amount: RESOURCE_PRICE_PAISE,
    });
  });
});
