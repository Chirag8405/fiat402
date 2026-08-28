/**
 * x402 payment gate for Next.js App Router route handlers, scheme "upi" /
 * network "upi:in" only.
 *
 * Field names and header shapes follow x402-specification-v2.md section 5.1
 * (PaymentRequired / PaymentRequirements) and section 5.3 (SettlementResponse),
 * and the HTTP transport's exact header mechanics in
 * x402-reference/specs/transports-v2/http.md ("Payment Required Signaling",
 * "Payment Payload Transmission", "Settlement Response Delivery"):
 *   - no/invalid payment  -> 402, base64 PAYMENT-REQUIRED header carrying PaymentRequired
 *   - valid payment       -> 200, base64 PAYMENT-RESPONSE header carrying SettlementResponse
 *
 * Verification/settlement is delegated to the deployed facilitator over
 * HTTP (POST FACILITATOR_URL/verify, POST FACILITATOR_URL/settle) per the
 * facilitator interface in CLAUDE.md ("Facilitator interface" section) and
 * x402-specification-v2.md section 7. This app does NOT import anything
 * from apps/facilitator/ -- that package's dependencies (express, cors,
 * razorpay, pg, dotenv) are not installed in this package's node_modules,
 * and Vercel only installs apps/merchant's own node_modules, so an
 * in-process/same-repo import would build here but fail in that deployment.
 * VerifyResponseBody/SettlementResponseBody below are the minimal shapes
 * this file needs, copied from apps/facilitator/src/server.ts's exported
 * types rather than imported.
 */

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

const SCHEME = "upi";
const NETWORK = "upi:in";
const X402_VERSION = 2;

/** Minimal shape of the facilitator's POST /settle response body (x402-specification-v2.md section 5.3). */
export interface SettlementResponseBody {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  extensions?: Record<string, unknown>;
}

/** Minimal shape of the facilitator's POST /verify response body (x402-specification-v2.md section 5.4). */
export interface VerifyResponseBody {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  extra?: Record<string, unknown>;
}

/**
 * POSTs to the deployed facilitator's /verify or /settle endpoint.
 * `agentHeader` is forwarded as X-Agent-Identifier -- the facilitator's own
 * HTTP routes read the caller's velocity-check identity from that header
 * (see apps/facilitator/src/server.ts's /verify and /settle routes), and
 * requestIp is derived facilitator-side from the real HTTP connection now
 * that this is a genuine network hop, so it doesn't need to be forwarded
 * explicitly.
 */
async function callFacilitator<T>(
  path: "/verify" | "/settle",
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  agentHeader: string | undefined,
): Promise<T> {
  const baseUrl = process.env.FACILITATOR_URL ?? "";
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(agentHeader ? { "X-Agent-Identifier": agentHeader } : {}),
    },
    body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements }),
  });

  if (!res.ok) {
    // Read as text, not json() -- a 429/5xx body from the facilitator (or a
    // platform-level gateway/proxy in front of it, e.g. Render rate
    // limiting) is frequently plain text ("Too Many Requests") or an HTML
    // error page, not JSON. Calling .json() on that throws a raw
    // SyntaxError instead of a clean, catchable Error -- see
    // apps/facilitator/src/policy/ai-advisory.ts's callGemini/callGroq for
    // the same fix applied to the Gemini/Groq HTTP calls.
    const bodyText = await res.text().catch(() => "<unreadable body>");
    throw new Error(`Facilitator ${path} request failed with status ${res.status}: ${bodyText}`);
  }

  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new Error(`Facilitator ${path} response body was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface ResourceInfo {
  url: string;
  description: string;
  mimeType?: string;
  serviceName?: string;
}

interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions: Record<string, unknown>;
}

/**
 * Reads MERCHANT_VPA / MERCHANT_NAME / RESOURCE_PRICE_PAISE from env and
 * builds this resource's single `accepts` entry. Read on every call (not
 * cached at module scope) so tests can vary env per-case via vi.stubEnv.
 */
function buildUpiRequirements(): PaymentRequirements {
  const payTo = process.env.MERCHANT_VPA ?? "";
  const merchantName = process.env.MERCHANT_NAME ?? "";
  const amount = process.env.RESOURCE_PRICE_PAISE ?? "";

  return {
    scheme: SCHEME,
    network: NETWORK,
    amount,
    asset: "INR",
    payTo,
    // TEMP: bumped 90 -> 180 to confirm the webhook-timing theory while
    // testing. Revert to 90 before the final demo.
    maxTimeoutSeconds: 180,
    extra: {
      merchantName,
      description: "Premium data access",
    },
  } as PaymentRequirements;
}

function encodeBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
}

/**
 * Builds a 402 response: the `PAYMENT-REQUIRED` header always carries the
 * full `PaymentRequired` challenge (spec 5.1) so the client can retry, and
 * `responseBody` -- when given -- is serialized as the JSON response body.
 * Used both for "no/malformed payment attached yet" (no responseBody, `{}`
 * per the transport spec's own examples) and for a verify/settle rejection
 * of an attached payment, where the caller passes the VerifyResponseBody/
 * SettlementResponseBody itself so `invalidReason`/`errorReason` are visible
 * in the body, not just paraphrased into PaymentRequired.error.
 */
function paymentRequiredResponse(resource: ResourceInfo, error: string | undefined, responseBody: unknown = {}): Response {
  const header: PaymentRequired = {
    x402Version: X402_VERSION,
    ...(error ? { error } : {}),
    resource,
    accepts: [buildUpiRequirements()],
    extensions: {},
  };

  return new Response(JSON.stringify(responseBody), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": encodeBase64(header),
    },
  });
}

/**
 * Base64-decodes and JSON-parses the `PAYMENT-SIGNATURE` header into a
 * `PaymentPayload` (x402-specification-v2.md section 5.2). All decode/parse
 * errors are caught here -- callers never see a decode exception, only a
 * `{ ok: false }` result -- so a malformed header can never reach the
 * facilitator calls below or bubble up as a 500.
 */
function decodePaymentSignature(header: string): { ok: true; payload: PaymentPayload } | { ok: false; error: string } {
  // Buffer.from(str, "base64") in Node silently ignores characters outside
  // the base64 alphabet instead of throwing, so an invalid-but-decodable-ish
  // string would otherwise slip past a bare try/catch around Buffer.from.
  // Validate the alphabet/padding shape first and reject anything that
  // isn't well-formed base64.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(header) || header.length % 4 !== 0 || header.length === 0) {
    return { ok: false, error: "PAYMENT-SIGNATURE header is not valid base64" };
  }

  let json: string;
  try {
    json = Buffer.from(header, "base64").toString("utf-8");
  } catch (err) {
    return { ok: false, error: `PAYMENT-SIGNATURE header failed to base64-decode: ${(err as Error).message}` };
  }

  try {
    const parsed = JSON.parse(json) as PaymentPayload;
    return { ok: true, payload: parsed };
  } catch (err) {
    return { ok: false, error: `PAYMENT-SIGNATURE header did not decode to valid JSON: ${(err as Error).message}` };
  }
}

/**
 * Protects a Next.js App Router GET handler behind the x402 upi scheme.
 * `resource` describes the protected route for the PaymentRequired.resource
 * field (spec 5.1.2 ResourceInfo).
 *
 * On success, calls `handler` and stamps the base64 `PAYMENT-RESPONSE`
 * header (SettlementResponse, spec 5.3) onto its response. On any failure
 * path, returns a 402 directly -- `handler` is never invoked without a
 * settled payment.
 */
export async function withX402Payment(
  request: Request,
  resource: ResourceInfo,
  handler: (settlement: SettlementResponseBody) => Promise<Response> | Response,
): Promise<Response> {
  const signatureHeader = request.headers.get("PAYMENT-SIGNATURE");

  if (!signatureHeader) {
    return paymentRequiredResponse(resource, "PAYMENT-SIGNATURE header is required");
  }

  const decoded = decodePaymentSignature(signatureHeader);
  if (!decoded.ok) {
    return paymentRequiredResponse(resource, decoded.error);
  }

  const paymentPayload = decoded.payload;
  const paymentRequirements = buildUpiRequirements();
  const agentHeader = request.headers.get("X-Agent-Identifier") ?? undefined;

  // callFacilitator throws (rather than returning a value) when the
  // facilitator is unreachable, rate-limited, or returns a non-JSON body --
  // per this function's own contract ("On any failure path, returns a 402
  // directly"), that must become a clean 402 here too, not an unhandled
  // exception that turns into Next.js's generic 500.
  let verifyResult: VerifyResponseBody;
  try {
    verifyResult = await callFacilitator<VerifyResponseBody>("/verify", paymentPayload, paymentRequirements, agentHeader);
  } catch (err) {
    return paymentRequiredResponse(resource, err instanceof Error ? err.message : String(err));
  }
  if (!verifyResult.isValid) {
    return paymentRequiredResponse(resource, verifyResult.invalidReason ?? "payment verification failed", verifyResult);
  }

  let settleResult: SettlementResponseBody;
  try {
    settleResult = await callFacilitator<SettlementResponseBody>("/settle", paymentPayload, paymentRequirements, agentHeader);
  } catch (err) {
    return paymentRequiredResponse(resource, err instanceof Error ? err.message : String(err));
  }
  if (!settleResult.success) {
    return paymentRequiredResponse(resource, settleResult.errorReason ?? "payment settlement failed", settleResult);
  }

  const response = await handler(settleResult);
  response.headers.set("PAYMENT-RESPONSE", encodeBase64(settleResult));
  return response;
}
