/**
 * UPI Payment Link creation, wrapping the Razorpay Payment Links API.
 *
 * Request fields (upi_link, amount, currency, description, expire_by) are
 * exactly CLAUDE.md's "Razorpay integration" section: "Create UPI Payment
 * Link: POST /v1/payment_links with upi_link: true, amount (paise),
 * currency: "INR", description, expire_by (unix timestamp at
 * maxTimeoutSeconds)." Cross-checked against
 * razorpay.com/docs/api/payments/payment-links/create-upi/, which confirms
 * `amount` is an integer in the smallest currency unit and `expire_by` is a
 * unix timestamp, both optional-by-SDK-type but required by this module's
 * contract.
 *
 * The Razorpay SDK's TypeScript type for the create body marks `customer` as
 * required (RazorpayPaymentLinkBaseRequestBody.customer), even though the
 * live docs list every `customer.*` sub-field as optional and don't require
 * `customer` itself for a UPI link. The `as Parameters<...>[0]` cast below
 * satisfies the stricter SDK type without fighting it or using `any` — by
 * default we send no `customer` field at all (equivalent to what the docs
 * describe as optional), and only add one when a caller opts in.
 *
 * Optional SMS notification (`notifyContact`): per
 * razorpay.com/docs/api/payments/payment-links/create-upi/, passing
 * `customer.contact` (E.164 phone number) plus `notify: { sms: true }` makes
 * Razorpay text the Payment Link to that number when it's created. Demo
 * convenience only — omit `notifyContact` (the default) to send neither
 * field, preserving the no-customer-data behavior above.
 *
 * Never lets a Razorpay API failure propagate as an unhandled exception:
 * every call is wrapped in try/catch and normalized into a typed error
 * result. The SDK's own error shape (confirmed by reading
 * node_modules/razorpay/dist/api.js's `normalizeError`) is
 * `throw { statusCode, error: { code, description, ... } }` — a plain
 * rejected object, not an Error instance — for HTTP-level API errors; a
 * network-level failure (no response at all, e.g. DNS/connection failure)
 * throws a plain Error instead, since `normalizeError` itself throws trying
 * to read `err.response.status` off an error with no `.response`. Both
 * shapes are handled below.
 */

import { razorpayClient } from "./client";

type CreatePaymentLinkParams = Parameters<typeof razorpayClient.paymentLink.create>[0];

export interface CreateUpiPaymentLinkSuccess {
  ok: true;
  paymentLinkId: string;
  shortUrl: string;
}

export interface CreateUpiPaymentLinkError {
  ok: false;
  errorCode: string | null;
  errorDescription: string;
}

export type CreateUpiPaymentLinkResult = CreateUpiPaymentLinkSuccess | CreateUpiPaymentLinkError;

/** Shape of the object the Razorpay SDK rejects with for an HTTP-level API error. */
interface RazorpaySdkErrorLike {
  statusCode: string | number;
  error: {
    code?: string;
    description?: string;
  };
}

function isRazorpaySdkErrorLike(value: unknown): value is RazorpaySdkErrorLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "object" &&
    (value as { error: unknown }).error !== null
  );
}

/**
 * Creates a UPI-only Razorpay Payment Link.
 *
 * @param amountPaise - Amount in paise (INR atomic unit), matching
 *   PaymentRequirements.amount's unit per x402-specification-v2.md section 5.1.2.
 * @param description - Shown to the payer on the Payment Link / UPI app.
 * @param expiryUnixTs - Unix timestamp (seconds) the link expires at; callers
 *   pass `now + maxTimeoutSeconds` per CLAUDE.md's state machine section.
 * @param notifyContact - Optional phone number in E.164 format (e.g.
 *   "+919876543210"). When provided, Razorpay SMSes the Payment Link to this
 *   number on creation. Omit to send no customer/notify data (the default).
 */
export async function createUpiPaymentLink(
  amountPaise: number,
  description: string,
  expiryUnixTs: number,
  notifyContact?: string,
): Promise<CreateUpiPaymentLinkResult> {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    return { ok: false, errorCode: null, errorDescription: "amountPaise must be a positive integer" };
  }
  if (!Number.isInteger(expiryUnixTs) || expiryUnixTs <= 0) {
    return { ok: false, errorCode: null, errorDescription: "expiryUnixTs must be a positive unix timestamp" };
  }

  const params: CreatePaymentLinkParams = {
    upi_link: true,
    amount: amountPaise,
    currency: "INR",
    description,
    expire_by: expiryUnixTs,
    ...(notifyContact
      ? {
          customer: { contact: notifyContact },
          notify: { sms: true },
        }
      : {}),
  } as Parameters<typeof razorpayClient.paymentLink.create>[0];

  try {
    const paymentLink = await razorpayClient.paymentLink.create(params);
    return { ok: true, paymentLinkId: paymentLink.id, shortUrl: paymentLink.short_url };
  } catch (err) {
    if (isRazorpaySdkErrorLike(err)) {
      console.log("[razorpay] SDK error:", JSON.stringify(err.error));
      return {
        ok: false,
        errorCode: err.error.code ?? null,
        errorDescription: err.error.description ?? "Razorpay API error with no description",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    console.log("[razorpay] Non-SDK error:", message);
    return { ok: false, errorCode: null, errorDescription: `Razorpay request failed: ${message}` };
  }
}
