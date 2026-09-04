# Scheme: `upi`

## Summary

`upi` is a scheme that transfers a specific amount of funds (in INR) from a client's UPI-linked
bank account to a merchant, settled via Razorpay UPI Payment Links. The resource server must
know in advance the exact amount of funds it needs to be transferred, expressed in paise (INR's
atomic unit).

## Example Use Cases

- Paying to view an article, priced in INR
- Purchasing digital credits from an Indian merchant
- An AI agent paying an INR-denominated API or tool on behalf of a human user

## Payment Flow

`exact` (see [scheme_exact.md](https://github.com/x402-foundation/x402/blob/230e6a9a7eebce22c911a0687d6f4e6d1ac019f7/specs/schemes/exact/scheme_exact.md)) uses the
`authorization` payment flow by default: the client produces a signed authorization, the
facilitator verifies it, the resource executes, then the facilitator settles by submitting the
pre-authorized transfer on-chain. That flow assumes settlement is near-instant once verification
passes, because verification of the signature is itself proof the payer authorized the transfer.

`upi` deliberately diverges from this. UPI has no client-side signing step and no on-chain
transfer to submit -- settlement means creating a Razorpay UPI Payment Link and waiting, bounded
by `maxTimeoutSeconds`, for the payer to approve the collect request on their own device and for
Razorpay to deliver a `payment.captured` webhook. This is asynchronous, bounded-wait settlement,
not a design gap:

1. `/verify` runs the deterministic policy engine (amount ceiling, merchant allowlist, velocity
   limit) and the AI advisory layer. There is no client-signed authorization to cryptographically
   verify at this stage, because `upi`'s `payload` carries none -- unlike `exact`'s `signature` +
   EIP-3009 `authorization` object (spec section 5.2.2), `upi`'s `payload` is just
   `{ payerVpa?: string, txnRef?: string }`. This is a deliberate protocol-level divergence, not
   a missing feature: the UPI collect flow requires the payer to approve the payment inside their
   own UPI app, on their own device, after the Payment Link is created. There is no artifact the
   client can sign and hand to the server up front, because the payer -- not the client software
   making the request -- is the only party capable of authorizing the transfer, and they do so
   out-of-band from this payload, after the request has already been sent. The "authorization"
   for a `upi` payment is therefore implicit in the `payment.captured` webhook event the
   facilitator receives asynchronously from Razorpay, not in anything signed and placed in
   `payload`.
2. `/settle` creates the Razorpay UPI Payment Link (`created` -> `pending`) and then blocks --
   via pub/sub, not polling -- until either a terminal webhook event arrives (`approved` /
   `declined` / `expired`) or `maxTimeoutSeconds` elapses, whichever is first.
3. The facilitator returns a `SettlementResponse` only once the wait resolves, so `/settle`
   always returns a clean, bounded response and never hangs, even though webhook delivery is
   outside its control.

Because `payload` carries no signature to verify before the resource executes, `upi` cannot rely
on `exact`'s verify-before-resource-then-settle sequencing the same way `exact` does for
instantly-settling networks: the authoritative confirmation that money moved only exists after
the bounded wait in `/settle` completes, not from anything `/verify` can check up front.
Implementations of this scheme MUST treat `/settle`'s webhook-driven bounded wait as the
authoritative settlement signal, not the absence of an error from `/verify`.

`payTo` for `upi` is the merchant's Razorpay VPA (e.g. `merchant@ybl`), not a wallet address.
This is distinct from `exact`'s `payTo`, which is a blockchain address that a signed transfer or
authorization names as the destination. UPI has no concept of an on-chain address; a VPA
(Virtual Payment Address) is the routable identifier UPI uses to resolve a payment to a bank
account, and it is what Razorpay's Payment Link API and the payer's UPI app both need in order
to route and display the collect request. Using the VPA here keeps `payTo` meaningful within the
scheme's own settlement network rather than forcing an unrelated address format onto a rail that
doesn't have one.

## Critical Validation Requirements

Facilitators MUST enforce the following before creating a Razorpay Payment Link in `/settle`:

### Razorpay UPI

- Amount exactness: the Payment Link's `amount` MUST equal `requirements.amount` (paise) exactly.
- Merchant binding: the Payment Link's payee MUST resolve to `requirements.payTo`; a facilitator
  MUST NOT create a Payment Link for a VPA not present in its merchant allowlist.
- Webhook signature validity: incoming Razorpay webhooks MUST be verified via HMAC-SHA256 over
  the raw request body bytes using `RAZORPAY_WEBHOOK_SECRET`, checked before any JSON parsing --
  a re-serialized body will fail the signature check due to whitespace/key ordering differences.
- Capture, not authorization, is the settlement signal: only `payment.captured` transitions a
  request to `approved`. `payment.authorized` alone MUST NOT be treated as settled, since
  Razorpay can auto-refund an authorized-but-uncaptured UPI payment.
- Bounded wait: `/settle` MUST resolve within `maxTimeoutSeconds` regardless of webhook delivery,
  returning `success: false` on expiry rather than hanging.
- Retry handling: a `payment.failed` event followed by a `payment.captured` event for the same
  Payment Link is expected behavior (the payer retried within the UPI app), not a bug --
  facilitators MUST transition a `declined` request back to `approved` if `payment.captured`
  arrives afterward, rather than treating the request as already terminal.

Network-specific implementation details (Payment Link creation parameters, the Redis key schema,
and the pub/sub resolution mechanism replacing bare polling) are documented in
`packages/scheme-upi/src/state-machine.ts` and in `fiat402/CLAUDE.md`.
