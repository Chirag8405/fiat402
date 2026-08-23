/**
 * Configured Razorpay SDK client instance.
 *
 * Reads RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from env and constructs one
 * shared client. Other modules (payment-links.ts, and any future Razorpay
 * callers) import `razorpayClient` from here rather than each constructing
 * their own — this is the single place credentials are read from env.
 *
 * Construction itself does not validate or throw on missing credentials: the
 * Razorpay SDK does not make a network call at construction time, so there is
 * nothing to fail yet. A missing/invalid key surfaces as an authentication
 * error on the first real API call, which payment-links.ts is responsible
 * for catching and turning into a typed error result (never an unhandled
 * exception) — see its top-of-file comment.
 */

import Razorpay from "razorpay";

export const razorpayClient = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
