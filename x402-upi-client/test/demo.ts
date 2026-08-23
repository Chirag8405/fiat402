// This demonstrates a genuine protocol extension — x402Client is unmodified,
// UpiSchemeClient uses the same public registration API as ExactEvmScheme,
// and no core payment selection logic was forked or patched.
// Registration pattern used: instance method (`x402Client.register(network, client)`)
// — confirmed by reading node_modules/@x402/core/dist/cjs/x402Client-DrAqoiD8.d.ts
// (the real, documented extension point) and node_modules/@x402/evm/dist/cjs/exact/client/index.d.ts
// (registerExactEvmScheme, which is a convenience wrapper built on top of that same
// instance method). See the header comment in src/upi-scheme-client.ts for full detail.

import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerUpiScheme } from "../src/index";

const MERCHANT_URL = process.env.MERCHANT_URL ?? "http://localhost:3001/api/premium-data";

async function main(): Promise<void> {
  const probe = await fetch(MERCHANT_URL).catch(() => undefined);
  if (!probe || probe.status !== 402) {
    console.error(
      "Merchant server not reachable or not returning 402 — is the stack running?",
    );
    process.exit(1);
  }

  const client = new x402Client();
  registerUpiScheme(client, {
    payerVpa: process.env.DEMO_PAYER_VPA,
  });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  const response = await fetchWithPayment(MERCHANT_URL);
  const body = await response.text();

  console.log("status:", response.status);
  console.log("headers:");
  for (const [key, value] of response.headers.entries()) {
    console.log(`  ${key}: ${value}`);
  }
  console.log("body:", body);
}

main().catch((error) => {
  console.error("Demo failed:", error);
  process.exit(1);
});
