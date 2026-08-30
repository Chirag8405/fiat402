/**
 * PAYMENT-SIGNATURE construction for ../app/api/simulate/route.ts's raw
 * header capture -- lives here rather than in route.ts itself because
 * Next's route-type checking rejects arbitrary named exports from a route
 * file (`.next/types` enforces this at build time, same constraint as
 * page.tsx files -- see ./trail.ts's top comment for the same issue hit
 * there). Also lets this be unit-tested directly, matching this package's
 * established pattern of pulling protocol-adjacent logic into a plain
 * function specifically so it doesn't need a route/request harness.
 *
 * SCOPE: only ../app/api/simulate/route.ts calls this -- see that route's
 * top-of-file comment for why raw header capture is scoped to
 * simulate-triggered runs only (x402-upi-client/test/demo.ts and the
 * merchant's x402-middleware.ts in general have no capture path at all).
 *
 * WHY THIS EXISTS: the real PAYMENT-SIGNATURE header is built inside
 * `wrapFetchWithPayment`'s own retry call, which only runs inside
 * route.ts's deferred `after()` block (that's the call that can take up to
 * 180s -- it can't be moved earlier without reintroducing the
 * blocking-response problem the whole simulate route is built to avoid).
 * `captureSignatureHeader` constructs it itself, one step earlier, by
 * calling the exact same public per-scheme method
 * (`UpiSchemeClient.createPaymentPayload`) the real client calls
 * internally, then assembling the outer PaymentPayload the same way --
 * confirmed by reading the actual installed
 * @x402/core/dist/cjs/client/index.js (`x402Client.createPaymentPayload`,
 * ~line 370), not assumed:
 *
 *   { x402Version: partialPayload.x402Version, payload: partialPayload.payload,
 *     extensions: mergeExtensions(paymentRequired.extensions, partialPayload.extensions),
 *     resource: paymentRequired.resource, accepted: requirements }
 *
 * then base64-encoded the same way `encodePaymentSignatureHeader` does
 * (@x402/core/dist/cjs/http/index.js): `Buffer.from(JSON.stringify(...),
 * "utf8").toString("base64")` -- identical to the merchant's own
 * `encodeBase64` helper (apps/merchant/lib/x402-middleware.ts).
 * `enrichPaymentPayloadWithExtensions` (called after, in the real client) is
 * a confirmed no-op here since this app registers no x402 extensions, only
 * a scheme.
 *
 * DETERMINISM -- confirmed, not assumed, by reading
 * x402-upi-client/src/upi-scheme-client.ts's createPaymentPayload in full:
 * it reads only `this.options` (payerVpa/agentMetadata, fixed per persona)
 * and the `x402Version` argument -- no `Date.now()`, no `randomUUID()`, no
 * nonce, and it never sets `txnRef` (the one field that WOULD introduce
 * non-determinism, via the facilitator's random-UUID fallback, happens
 * server-side, after this payload is already built). `_context` is accepted
 * but never read. The merchant's own `buildUpiRequirements()` is likewise
 * pure env-var reads, no clock/random input.
 *
 * So this is genuinely deterministic end to end, not "a signature built the
 * same way" as a hedge: given the same PAYMENT-REQUIRED content and persona
 * options, this construction is BYTE-IDENTICAL to what the real deferred
 * call in route.ts's `after()` will produce later -- provided the object
 * keys below are inserted in the same order as the real client's own
 * literal (JSON.stringify serializes by key insertion order): x402Version,
 * payload, extensions, resource, accepted. test/simulate-headers.test.ts
 * asserts on the raw base64 string itself (not just the decoded shape) to
 * make this claim fail loudly if it ever stops being true. This can
 * genuinely be shown in a demo as the actual signature, not an
 * approximation of one.
 */

import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { UpiSchemeClient } from "@fiat402/x402-upi-client";

export interface Persona {
  label: string;
  taskContext: string;
}

/**
 * `paymentRequired` is the current run's own already-captured,
 * already-decoded PAYMENT-REQUIRED header -- not re-fetched.
 */
export async function captureSignatureHeader(paymentRequired: PaymentRequired, persona: Persona): Promise<string> {
  const requirements = (paymentRequired.accepts as PaymentRequirements[]).find(
    entry => entry.scheme === "upi" && entry.network === "upi:in",
  );
  if (!requirements) {
    throw new Error(
      `no "upi"/"upi:in" entry in PAYMENT-REQUIRED's accepts[] (found: ${paymentRequired.accepts.map((e: PaymentRequirements) => `${e.scheme}/${e.network}`).join(", ")})`,
    );
  }

  // A standalone UpiSchemeClient instance -- same options as the one
  // route.ts registers on its own x402Client for the real deferred call, so
  // this produces the same output. Never registered on an x402Client /
  // never sends anything itself; only its pure createPaymentPayload method
  // is called directly, one step earlier than usual.
  const schemeClient = new UpiSchemeClient({
    payerVpa: process.env.DEMO_PAYER_VPA,
    agentMetadata: { taskContext: persona.taskContext },
  });
  const partialPayload = await schemeClient.createPaymentPayload(paymentRequired.x402Version, requirements, {
    extensions: paymentRequired.extensions,
  });

  // Mirrors x402Client.createPaymentPayload's own assembly exactly (see
  // this file's top comment for the traced source) -- key order matters for
  // a byte-identical JSON.stringify result, not just this shape.
  const mergedExtensions = { ...(paymentRequired.extensions ?? {}), ...(partialPayload.extensions ?? {}) };
  const paymentPayload = {
    x402Version: partialPayload.x402Version,
    payload: partialPayload.payload,
    extensions: mergedExtensions,
    resource: paymentRequired.resource,
    accepted: requirements,
  };

  return Buffer.from(JSON.stringify(paymentPayload), "utf8").toString("base64");
}
