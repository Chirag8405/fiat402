import { describe, it, expect } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import type {
  UpiPaymentRequirementsExtra,
  UpiPaymentRequirements,
  UpiPaymentPayload,
  UpiSchemeClientInterface,
} from "../src/types";

describe("scheme-upi types", () => {
  it("compiles a sample UpiPaymentRequirements that satisfies the base PaymentRequirements shape from @x402/core", () => {
    const extra: UpiPaymentRequirementsExtra = {
      merchantName: "Acme Chai Stall",
      description: "One cup of chai",
    };

    // scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra --
    // field names exactly as in x402-specification-v2.md section 5.1.2.
    const requirements: UpiPaymentRequirements = {
      scheme: "upi",
      network: "upi:in",
      amount: "10000",
      asset: "INR",
      payTo: "merchant@ybl",
      maxTimeoutSeconds: 90,
      extra,
    };

    // UpiPaymentRequirements must be assignable to the base PaymentRequirements
    // type from @x402/core -- this is a compile-time check via `satisfies`.
    const asBase = requirements satisfies PaymentRequirements;

    expect(asBase.scheme).toBe("upi");
    expect(asBase.network).toBe("upi:in");
    expect(asBase.amount).toBe("10000");
    expect(asBase.asset).toBe("INR");
    expect(asBase.payTo).toBe("merchant@ybl");
    expect(asBase.maxTimeoutSeconds).toBe(90);
    expect(asBase.extra).toEqual(extra);
  });

  it("allows UpiPaymentPayload with both payerVpa and txnRef present", () => {
    const payload: UpiPaymentPayload = {
      payerVpa: "payer@okhdfcbank",
      txnRef: "order-4471",
    };

    expect(payload.payerVpa).toBe("payer@okhdfcbank");
    expect(payload.txnRef).toBe("order-4471");
  });

  it("allows UpiPaymentPayload with only payerVpa present", () => {
    const payload: UpiPaymentPayload = {
      payerVpa: "payer@okhdfcbank",
    };

    expect(payload.payerVpa).toBe("payer@okhdfcbank");
    expect(payload.txnRef).toBeUndefined();
  });

  it("allows UpiPaymentPayload with only txnRef present", () => {
    const payload: UpiPaymentPayload = {
      txnRef: "order-4471",
    };

    expect(payload.txnRef).toBe("order-4471");
    expect(payload.payerVpa).toBeUndefined();
  });

  it("allows UpiPaymentPayload with neither field present -- UPI collect flow needs neither upfront", () => {
    const payload: UpiPaymentPayload = {};

    expect(payload.payerVpa).toBeUndefined();
    expect(payload.txnRef).toBeUndefined();
  });

  it("UpiSchemeClientInterface shape matches SchemeNetworkClient's createPaymentPayload contract", () => {
    const client: UpiSchemeClientInterface = {
      scheme: "upi",
      async createPaymentPayload(x402Version, paymentRequirements) {
        expect(x402Version).toBe(2);
        expect(paymentRequirements.scheme).toBe("upi");
        return { x402Version, payload: { payerVpa: undefined, txnRef: undefined } };
      },
    };

    const requirements: UpiPaymentRequirements = {
      scheme: "upi",
      network: "upi:in",
      amount: "10000",
      asset: "INR",
      payTo: "merchant@ybl",
      maxTimeoutSeconds: 90,
      extra: { merchantName: "Acme Chai Stall", description: "One cup of chai" },
    };

    return client.createPaymentPayload(2, requirements).then(result => {
      expect(result.x402Version).toBe(2);
    });
  });
});
