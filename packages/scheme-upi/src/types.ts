/**
 * Type definitions for the "upi" x402 payment scheme (scheme: "upi", network: "upi:in").
 *
 * Field names on PaymentRequirements mirror x402-specification-v2.md section 5.1.2
 * exactly (scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra) -- see
 * https://github.com/x402-foundation/x402/blob/230e6a9a7eebce22c911a0687d6f4e6d1ac019f7/specs/x402-specification-v2.md#L108-L130
 * (x402-foundation/x402, commit 230e6a9a, 2026-08-21 -- the exact spec version this
 * scheme was built against; see README.md's "Built against" note). Do not rename
 * these fields; other modules (state-machine.ts, the /verify and /settle handlers)
 * read requirements objects by these exact keys.
 *
 * The base PaymentRequirements/PaymentPayload/SchemeNetworkClient shapes are re-used
 * from @x402/core/types (published package, x402-foundation/x402 typescript/packages/core).
 * Confirmed from typescript/packages/core/src/types/payments.ts and
 * typescript/packages/core/src/types/mechanisms.ts in that repo at the same pinned
 * commit above.
 */

import type {
  PaymentRequirements,
  SchemeNetworkClient,
  SchemeClientHooks,
  FindDefaultAsset,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";

/**
 * UPI-specific fields carried in PaymentRequirements.extra.
 * Spec 5.1.2 reserves `assetTransferMethod` and `paymentFlow` as protocol keys in
 * `extra`; all other keys are scheme-specific. `merchantName` and `description` are
 * this scheme's keys, per fiat402/CLAUDE.md's x402 v2 wire format section.
 */
export interface UpiPaymentRequirementsExtra {
  merchantName: string;
  description: string;
  // Index signature makes this assignable to @x402/core's `extra: Record<string, unknown>`
  // (PaymentRequirements.extra is required there, not optional as the spec table implies).
  [key: string]: unknown;
}

/**
 * PaymentRequirements for scheme "upi", network "upi:in".
 *
 * `payTo` is the merchant's Razorpay VPA (e.g. "merchant@ybl"), not a wallet address --
 * see docs/scheme_upi.md "Payment Flow" for why. Field names here are exactly those in
 * x402-specification-v2.md section 5.1.2; only `scheme`, `network`, and `extra` are
 * narrowed to this scheme's literal/shape, everything else keeps the core type's shape.
 */
export interface UpiPaymentRequirements extends Omit<PaymentRequirements, "scheme" | "network" | "extra"> {
  scheme: "upi";
  network: "upi:in";
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: UpiPaymentRequirementsExtra;
}

/**
 * PaymentPayload.payload for scheme "upi".
 *
 * Unlike exact/EVM (spec 5.2.2: `signature` + an EIP-3009 `authorization` object,
 * see also https://github.com/x402-foundation/x402/blob/230e6a9a7eebce22c911a0687d6f4e6d1ac019f7/specs/schemes/exact/scheme_exact.md),
 * there is no
 * client-side cryptographic authorization step here. This is a deliberate
 * protocol-level divergence, not a missing feature: the UPI collect flow requires
 * the payer to approve the payment inside their own UPI app, on their own device,
 * after the facilitator creates a Razorpay Payment Link. The client cannot produce
 * a signed authorization up front because there is nothing for it to sign -- the
 * payer's device is the only party that can authorize the transfer, and it does so
 * out-of-band from this payload. "Authorization" is therefore implicit in the
 * payment.captured webhook event the facilitator receives asynchronously (see
 * fiat402/CLAUDE.md's Razorpay integration and state machine sections), not in
 * anything signed and placed in `payload` here.
 *
 * Both fields are optional because the UPI collect flow does not require the client
 * to supply a payer VPA or transaction reference upfront -- the payer enters/approves
 * the request on their own device, and the facilitator can derive a requestId without
 * `txnRef` (see fiat402/CLAUDE.md's Redis key schema section).
 */
export interface UpiPaymentPayload {
  payerVpa?: string;
  txnRef?: string;
}

/**
 * Interface that UpiSchemeClient (Module 8) must implement to register with x402Client
 * via `client.register("upi:in", new UpiSchemeClient(...))`.
 *
 * Mirrors @x402/core's `SchemeNetworkClient`, the interface `ExactEvmScheme` implements
 * (x402-foundation/x402, typescript/packages/mechanisms/evm/src/exact/client/scheme.ts):
 *
 *   export class ExactEvmScheme implements SchemeNetworkClient {
 *     readonly scheme = "exact";
 *     findDefaultAsset = findDefaultAsset;
 *     constructor(private readonly signer: ClientEvmSigner, private readonly options?: EvmSchemeOptions) {}
 *     async createPaymentPayload(x402Version, paymentRequirements, context?): Promise<PaymentPayloadResult> { ... }
 *   }
 *
 * `findDefaultAsset` and `schemeHooks` are optional on SchemeNetworkClient; UpiSchemeClient
 * is not required to implement them.
 */
export interface UpiSchemeClientInterface extends SchemeNetworkClient {
  readonly scheme: "upi";
  readonly schemeHooks?: SchemeClientHooks;
  findDefaultAsset?: FindDefaultAsset;

  createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult>;
}
