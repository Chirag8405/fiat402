/**
 * Configured Razorpay SDK client instance.
 *
 * Reads RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from env and constructs one
 * shared client. Other modules (payment-links.ts, and any future Razorpay
 * callers) import `razorpayClient` from here rather than each constructing
 * their own — this is the single place credentials are read from env.
 *
 * Construction is deferred behind a Proxy until the first property access,
 * rather than happening eagerly at module load: the installed razorpay SDK
 * (node_modules/razorpay/dist/razorpay.js) throws synchronously in its own
 * constructor when both key_id and oauthToken are missing, so an eager
 * `new Razorpay(...)` at module scope would crash any code path that merely
 * imports this module before env is populated -- e.g. Next.js's build-time
 * "Collecting page data" step, which loads every route module. Real calls
 * only happen from payment-links.ts's createUpiPaymentLink, well after
 * runtime env is loaded, so a missing/invalid key still surfaces there as an
 * authentication error on the first real API call, not an import-time crash.
 */

import Razorpay from "razorpay";

let instance: Razorpay | undefined;

function getRazorpayClient(): Razorpay {
  if (!instance) {
    instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return instance;
}

export const razorpayClient: Razorpay = new Proxy({} as Razorpay, {
  get(_target, prop, receiver) {
    return Reflect.get(getRazorpayClient(), prop, receiver);
  },
});
