import type { x402Client } from "@x402/core/client";
import { UpiSchemeClient, type UpiSchemeClientOptions } from "./upi-scheme-client";

export { UpiSchemeClient, type UpiSchemeClientOptions };

/**
 * Registers the "upi" scheme (network "upi:in") on an x402Client instance.
 *
 * Mirrors `registerExactEvmScheme(client, config)` from "@x402/evm"
 * (node_modules/@x402/evm/dist/cjs/exact/client/index.d.ts): that function is a
 * standalone convenience wrapper which, per its own tsdoc example, does nothing more
 * than build a scheme instance and call the real extension point,
 * `x402Client.register(network, client)` (confirmed as a genuine instance method on
 * `x402Client` in node_modules/@x402/core/dist/cjs/x402Client-DrAqoiD8.d.ts). This
 * function does exactly the same thing for "upi:in" — it is exported unconditionally
 * (regardless of which pattern turned out to be real) so callers have one named entry
 * point, matching the `registerExactEvmScheme` convention used across other scheme
 * packages.
 */
export function registerUpiScheme(client: x402Client, options?: UpiSchemeClientOptions): x402Client {
  return client.register("upi:in", new UpiSchemeClient(options));
}
