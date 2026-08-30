import { describe, it, expect } from "vitest";
import type { PaymentRequired } from "@x402/core/types";
import { captureSignatureHeader, type Persona } from "../lib/simulate-headers";

/**
 * Confirms the determinism claim in app/api/simulate/route.ts's top-of-file
 * comment concretely, not just by inspection: UpiSchemeClient.createPaymentPayload
 * reads only its options and the x402Version argument (no clock, no random
 * id), so the same inputs must produce byte-identical output, not merely
 * structurally-equivalent output -- these tests assert on the raw base64
 * string itself, which would fail on any nondeterminism (key-order drift,
 * a timestamp, a generated id) even if the decoded shape still "looked
 * right."
 */

function buildPaymentRequired(overrides: Partial<PaymentRequired> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "https://merchant.example/api/premium-data", description: "Premium data access" },
    accepts: [
      {
        scheme: "upi",
        network: "upi:in",
        amount: "10000",
        asset: "INR",
        payTo: "merchant@ybl",
        maxTimeoutSeconds: 180,
        extra: { merchantName: "Acme", description: "Premium data access" },
      },
    ],
    extensions: {},
    ...overrides,
  } as PaymentRequired;
}

const persona: Persona = { label: "ResearchBot", taskContext: "Fetch premium market data for client report" };

describe("captureSignatureHeader", () => {
  it("is byte-identical across repeated calls with the same inputs", async () => {
    const paymentRequired = buildPaymentRequired();
    const first = await captureSignatureHeader(paymentRequired, persona);
    const second = await captureSignatureHeader(paymentRequired, persona);
    expect(first).toBe(second);
  });

  it("decodes to a well-formed PaymentPayload carrying the requirements and persona's taskContext", async () => {
    const paymentRequired = buildPaymentRequired();
    const header = await captureSignatureHeader(paymentRequired, persona);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));

    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted).toEqual(paymentRequired.accepts[0]);
    expect(decoded.resource).toEqual(paymentRequired.resource);
    expect(decoded.extensions.agentMetadata.taskContext).toBe(persona.taskContext);
  });

  it("differs when the persona's taskContext differs -- not a fixed/cached value", async () => {
    const paymentRequired = buildPaymentRequired();
    const researchbotHeader = await captureSignatureHeader(paymentRequired, persona);
    const travelbotHeader = await captureSignatureHeader(paymentRequired, {
      label: "TravelBot",
      taskContext: "Booking a one-way flight to Goa",
    });
    expect(researchbotHeader).not.toBe(travelbotHeader);
  });

  it("throws when the PAYMENT-REQUIRED payload has no upi/upi:in entry, rather than silently building a signature for the wrong scheme", async () => {
    const paymentRequired = buildPaymentRequired({
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1", asset: "USDC", payTo: "0x0", maxTimeoutSeconds: 60, extra: {} }] as never,
    });
    await expect(captureSignatureHeader(paymentRequired, persona)).rejects.toThrow(/upi/);
  });
});
