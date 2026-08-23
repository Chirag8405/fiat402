/**
 * UpiSchemeClient: a genuine x402 protocol extension for scheme "upi", network "upi:in".
 *
 * TYPE-INSPECTION NOTES (read node_modules/@x402/{core,fetch,evm}/dist/**\/*.d.ts
 * at 2023-08-23, package version 2.23.0, before writing anything below):
 *
 * 1. `SchemeNetworkClient` (node_modules/@x402/core/dist/cjs/x402Client-DrAqoiD8.d.ts,
 *    re-exported from "@x402/core/types") is an INTERFACE:
 *
 *      interface SchemeNetworkClient {
 *        readonly scheme: string;
 *        readonly schemeHooks?: SchemeClientHooks;
 *        findDefaultAsset?: FindDefaultAsset;
 *        createPaymentPayload(
 *          x402Version: number,
 *          paymentRequirements: PaymentRequirements,
 *          context?: PaymentPayloadContext,
 *        ): Promise<PaymentPayloadResult>;
 *      }
 *
 *    `PaymentPayloadResult` = `Pick<PaymentPayload, "x402Version" | "payload"> &
 *    { extensions?: Record<string, unknown> }`. `PaymentPayloadContext` = `{ extensions?:
 *    Record<string, unknown> }`.
 *
 *    This is identical, field-for-field, to `UpiSchemeClientInterface` in
 *    packages/scheme-upi/src/types.ts — no divergence found. That file's declared
 *    shape was already written against the real installed `SchemeNetworkClient`, so
 *    the installed types remain authoritative and this class implements both.
 *
 * 2. `x402Client` (same file) has a real INSTANCE METHOD:
 *
 *      register(network: Network, client: SchemeNetworkClient): x402Client;
 *
 *    `@x402/fetch`'s own tsdoc example for `wrapFetchWithPayment` demonstrates this
 *    exact call shape directly:
 *
 *      const client = new x402Client()
 *        .register('eip155:8453', new ExactEvmScheme(evmSigner))
 *        .register('solana:mainnet', new ExactSvmScheme(svmSigner));
 *
 *    There is no standalone "registerExactEvmScheme"-equivalent inside @x402/fetch
 *    itself — @x402/fetch only exports `wrapFetchWithPayment` and
 *    `wrapFetchWithPaymentFromConfig`.
 *
 * 3. `@x402/evm` (node_modules/@x402/evm/dist/cjs/exact/client/index.d.ts) DOES export
 *    a standalone convenience function on top of the instance method:
 *
 *      declare function registerExactEvmScheme(
 *        client: x402Client,
 *        config: EvmClientConfig,
 *      ): x402Client;
 *
 *    Its own tsdoc example shows it is a thin wrapper: it builds `new
 *    ExactEvmScheme(config.signer, config.schemeOptions)` internally and calls
 *    `client.register(network, scheme)` for each configured network (wildcard
 *    "eip155:*" by default). So BOTH patterns are real and coexist: `.register()` is
 *    the core primitive on `x402Client`, and `registerExactEvmScheme` is a
 *    scheme-package convenience built on top of it — this is the actual, confirmed
 *    "public extension API" a scheme package is expected to expose alongside its
 *    client class.
 *
 * CHOSEN PATTERN: mirror `@x402/evm` exactly. `UpiSchemeClient` implements
 * `SchemeNetworkClient` directly (this file), and `registerUpiScheme(client, options)`
 * in ./index.ts is the standalone convenience function calling
 * `client.register("upi:in", new UpiSchemeClient(options))` — see index.ts for why
 * that split exists and how it maps to `registerExactEvmScheme`.
 */

import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
} from "@x402/core/types";
import type { UpiPaymentPayload, UpiSchemeClientInterface } from "@fiat402/scheme-upi/src/types";

/** Options accepted by UpiSchemeClient's constructor. */
export interface UpiSchemeClientOptions {
  /**
   * Optional payer VPA to attach to every payment payload this client builds.
   * The UPI collect flow does not require this upfront (the payer approves the
   * collect request inside their own UPI app, on their own device), so it is
   * genuinely optional here, not a stand-in for a missing required field.
   */
  payerVpa?: string;
}

/**
 * Client-side implementation of the "upi" x402 scheme, network "upi:in".
 *
 * Registered against an `x402Client` exactly the way `ExactEvmScheme` is: either
 * directly via `client.register("upi:in", new UpiSchemeClient(...))`, or through the
 * `registerUpiScheme` convenience function in ./index.ts (mirrors
 * `registerExactEvmScheme` from "@x402/evm").
 */
export class UpiSchemeClient implements UpiSchemeClientInterface {
  readonly scheme = "upi" as const;

  constructor(private readonly options?: UpiSchemeClientOptions) {}

  /**
   * Builds the PaymentPayload.payload for a "upi" PaymentRequirements entry.
   *
   * Divergence from ExactEvmScheme's createPaymentPayload, documented per the
   * module brief: EVM's version produces a cryptographic signature (EIP-3009
   * transferWithAuthorization or Permit2) over the payment terms, signed locally
   * with the client's private key. There is no client-side private key in the UPI
   * flow, and therefore nothing to sign here. What this method actually does is
   * construct the (optional) `UpiPaymentPayload` — `{ payerVpa?, txnRef? }` — that
   * tells the facilitator how to build the Razorpay Payment Link; the actual payer
   * authorization happens out-of-band, asynchronously, when the payer approves the
   * collect request in their own UPI app. The facilitator learns that happened via
   * the `payment.captured` Razorpay webhook, not via anything returned from this
   * method. See packages/scheme-upi/src/types.ts's UpiPaymentPayload doc comment
   * for the full rationale.
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    if (paymentRequirements.scheme !== "upi" || paymentRequirements.network !== "upi:in") {
      throw new Error(
        `UpiSchemeClient cannot build a payload for scheme "${paymentRequirements.scheme}" ` +
          `network "${paymentRequirements.network}" — it only handles scheme "upi", network "upi:in".`,
      );
    }

    const payload: UpiPaymentPayload = {};
    if (this.options?.payerVpa) {
      payload.payerVpa = this.options.payerVpa;
    }

    return {
      x402Version,
      // PaymentPayload.payload is typed `Record<string, unknown>` in @x402/core/types;
      // UpiPaymentPayload has no index signature (it is a closed, documented shape), so
      // this cast just bridges that gap — the runtime value is unchanged.
      payload: payload as Record<string, unknown>,
    };
  }
}
