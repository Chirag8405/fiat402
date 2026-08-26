What this is
fiat402 is a standalone x402 facilitator adding a upi payment scheme settled via Razorpay, using the self-facilitation pattern from x402-foundation/x402. We are NOT modifying the upstream repo. We build a standalone facilitator speaking its standard interface with our own scheme: "upi" / network: "upi:in" pair.
The absolute rule
Before writing any module touching x402 wire format, facilitator interface shapes, or client SDK usage: read the referenced file(s) in x402-reference/. If a field name or interface shape is unclear, re-read the file. Do not invent field names from training data.
x402 v2 wire format (confirmed field names)
Transport:

Server to client (payment required): HTTP 402, base64-encoded PAYMENT-REQUIRED header
Client to server (payment attempt): base64-encoded PAYMENT-SIGNATURE header
Server to client (success): 200 OK, base64-encoded PAYMENT-RESPONSE header

PaymentRequired object fields: x402Version, error (optional), resource (url, description, mimeType, serviceName, tags, iconUrl), accepts (array), extensions (object)

PaymentRequirements fields (each entry in accepts):

scheme: string, "upi"
network: string, "upi:in" (CAIP-2 format; spec explicitly supports fiat rail identifiers like "ach:us", "sepa:eu")
amount: string, paise (INR atomic unit). ₹100 = "10000"
asset: string, "INR" (ISO 4217 code — spec allows this for fiat)
payTo: string, merchant's Razorpay account reference or VPA. Decision: use the merchant's VPA (e.g. merchant@ybl) — document this in scheme_upi.md as distinct from a wallet address
maxTimeoutSeconds: number, 90
extra: object, UPI-specific fields: { merchantName: string, description: string }

PaymentPayload fields (client to server):

x402Version: number, 2
resource: object, optional
accepted: object, the chosen PaymentRequirements
payload: object. For upi: { payerVpa?: string, txnRef?: string } — payer VPA is optional since UPI collect flow doesn't require client to supply it upfront. Define in packages/scheme-upi/src/types.ts
extensions: object, optional

SettlementResponse fields:

success: boolean, required
errorReason: string, optional
payer: string, optional
transaction: string, Razorpay payment_id on success, "" (empty string per spec 5.3.2) on failure
network: string, "upi:in"
amount: string, optional
extensions: object, optional

VerifyResponse fields:

isValid: boolean, required
invalidReason: string, optional
payer: string, optional
extra: object — put AI advisory recommendation + justification here
x402Client scheme registration (confirmed from @x402/fetch npm page and examples/typescript/clients/fetch)
The @x402/fetch package exposes x402Client with a .register(network, schemeClient) method. This is the public extension point — it is how EVM and SVM schemes are registered, and it is how our upi scheme client registers itself. Pattern from the live fetch example in x402-reference:

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";

const client = new x402Client();

// EVM registers like this:

// registerExactEvmScheme(client, { signer: ... });

// Our upi scheme registers analogously:

client.register("upi:in", new UpiSchemeClient({ /* config */ }));

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

UpiSchemeClient must implement the same interface that ExactEvmClient implements. Read x402-reference/typescript/packages/x402-fetch/src/ and x402-reference/typescript/packages/x402-evm/src/exact/client.ts to get the exact interface shape before writing UpiSchemeClient. This means Module 8 is a genuine protocol extension using the public API, not a fork or workaround.
Facilitator interface (from specs/x402-specification-v2.md section 7)
POST /verify — request: { x402Version, paymentPayload, paymentRequirements }. Response: VerifyResponse. Runs deterministic engine FIRST; only if it passes, runs AI advisory. AI output goes in extra, never overrides isValid downward at this stage.
POST /settle — same request shape. UPI collect fires here. Bounded wait happens here. Response: SettlementResponse.
GET /supported — response: { kinds: [{x402Version: 2, scheme: "upi", network: "upi:in"}], extensions: [], signers: {} }
State machine
States: created -> pending -> approved | declined | expired -> settled | failed

created: /settle called, all checks passed, about to create Razorpay Payment Link
pending: Payment Link created (upi_link: true), collect live, waiting on webhook
approved: payment.captured webhook received (see Razorpay section below)
declined / expired: payment.failed webhook OR maxTimeoutSeconds elapsed — clean SettlementResponse with success: false, never a hung request
settled / failed: terminal — write full reconciliation record to Postgres
Redis key schema (authoritative — every module reads and writes these exact keys)
This schema exists so that Module 2 (velocity check), Module 4 (webhook handler), Module 5a (state machine / store), and Module 5b (server) never diverge on naming. Do not invent alternate key shapes in any module — import these from packages/scheme-upi/src/state-machine.ts, which is the single place key strings are constructed.

req:{requestId}:state — string, current state machine state (one of the 6 states above). requestId is generated by the facilitator when /settle is first called for a given payload — derive it deterministically from a hash of (paymentRequirements.payTo + paymentRequirements.amount + payload.payload.txnRef or a generated UUID if txnRef absent), so concurrent /settle calls for the same logical request converge on the same requestId. Document the exact hash/derivation in state-machine.ts.
req:{requestId}:paymentLinkId — string, Razorpay payment_link_id once created. Existence of this key is what Module 5b checks before creating a duplicate Payment Link on a concurrent /settle call.
req:{requestId}:meta — hash, { amount, payTo, createdAt, expiresAt }
velocity:{agentIdentifier} — sorted set, timestamps for the 1-minute sliding window used by Module 2's velocity check. agentIdentifier is defined in Module 2.
confirm-gate:{requestId} — string "0" or "1", the demo-hook confirmation flag referenced in Module 5b's /settle flow for AI hold/flag outcomes.

All keys get a TTL of maxTimeoutSeconds + 60 (buffer for reconciliation write) so Redis self-cleans; do not rely on manual deletion.
Pub/sub event schema (authoritative — Module 5a publishes, Module 5b's bounded
wait subscribes, Module 7's dashboard subscribes)
Channel: fiat402:events

Every event published to this channel is JSON with this shape:

{

  "requestId": "string",

  "state": "created|pending|approved|declined|expired|settled|failed",

  "previousState": "string or null",

  "timestamp": "ISO 8601 string",

  "meta": {

    "paymentLinkId": "string or null",

    "razorpayPaymentId": "string or null",

    "reason": "string or null"

  }

}

Resolution mechanism (replaces bare polling): the /settle handler in Module 5b does NOT sit in a bare while loop polling Redis every second. Instead, on entering pending it subscribes to fiat402:events filtered to its own requestId (or uses a per-request Redis pub/sub channel fiat402:events:{requestId} if the pub/sub client library makes filtering awkward — pick one and document it in state-machine.ts) and awaits either a terminal-state event or maxTimeoutSeconds elapsing, whichever comes first. This is what makes the UPI retry edge case work: when webhook-handler.ts transitions a request from declined back to approved (see Razorpay section), it publishes a new event on the same channel, and the still-listening /settle handler picks it up and resolves correctly — a bare polling loop that already exited on "declined" would miss this entirely. If you are tempted to implement this as polling for expedience, do not — state explicitly in code comments why pub/sub is required here, not just a style preference.

The dashboard's SSE relay (Module 7) subscribes to the same fiat402:events channel unfiltered and forwards every event to connected browsers.
Razorpay integration
Webhook sequence for UPI Payment Links (confirmed from razorpay.com/docs/webhooks/payments): for a completed UPI payment, Razorpay fires both events in sequence: payment.authorized (awaiting capture), then payment.captured (funds confirmed, capture complete).

For this build, listen to payment.captured as the trigger to transition pending -> approved. This is the definitive "money moved" signal. payment.authorized alone is not sufficient for UPI — Razorpay can auto-refund an authorized-but-uncaptured UPI payment.

For failure: listen to payment.failed.

UPI retry edge case (from Razorpay docs): you may occasionally receive payment.failed followed by payment.captured for the same Payment Link if the user retries within the UPI app. Handle this by checking whether the request is already in declined state when payment.captured arrives — if so, transition it back to approved, publish the transition on fiat402:events (see pub/sub section above) so the still-listening bounded wait resolves. Log this case explicitly — it is expected behavior per Razorpay docs, not a bug.

Create UPI Payment Link: POST /v1/payment_links with upi_link: true, amount (paise), currency: "INR", description, expire_by (unix timestamp at maxTimeoutSeconds).

Webhook signature verification: header X-Razorpay-Signature, algorithm HMAC-SHA256 of raw request body bytes using RAZORPAY_WEBHOOK_SECRET. Critical: verify against raw bytes BEFORE any JSON parsing — re-serialized body will fail signature check due to whitespace/key ordering differences.

Payment Link webhook events to subscribe: payment_link.paid (Payment Link-specific event), payment.captured (underlying payment captured). Subscribe to both in Razorpay Dashboard -> Webhooks for maximum reliability.
Deterministic policy engine
Runs inside /verify, before any AI call. Final authority — nothing overrides its false:

Hard ceiling: reject if requirements.amount (paise) > MAX_AMOUNT_PAISE env var
Merchant allowlist: reject if requirements.payTo not in ALLOWED_MERCHANTS env var
Velocity limit: reject if agent identifier exceeded MAX_REQUESTS_PER_MINUTE in Redis (key: velocity:{agentIdentifier}, see Redis key schema above) — Redis unavailable = fail closed (reject)
AI advisory layer
Only called after deterministic engine passes:

Try Gemini (gemini-2.5-flash-lite), 5s timeout
On failure, try Groq (llama-3.3-70b-versatile), 5s timeout
On both failing, return { recommendation: "hold", justification: "AI unavailable — fail-closed", provider: "fail-closed" }
Return value is ALWAYS advisory. "approve" = no added friction. "hold"/"flag" = require confirmation gate before Razorpay call fires
NEVER return "approve" on any failure path
Log deterministic decision + AI recommendation side by side every time
Session hygiene (Claude Code specific)
One Claude Code session per module.
Run /compact between modules if context is getting large — this is a Claude Code slash command, not a chat-interface behavior; it summarizes and trims the current session's context so the next module's file reads don't get crowded out.
Reference files precisely — only the specific path named, not the whole tree.
"Read X before writing" is a hard requirement, not a suggestion.
