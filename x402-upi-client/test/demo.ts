// This demonstrates a genuine protocol extension — x402Client is unmodified,
// UpiSchemeClient uses the same public registration API as ExactEvmScheme,
// and no core payment selection logic was forked or patched.
// Registration pattern used: instance method (`x402Client.register(network, client)`)
// — confirmed by reading node_modules/@x402/core/dist/cjs/x402Client-DrAqoiD8.d.ts
// (the real, documented extension point) and node_modules/@x402/evm/dist/cjs/exact/client/index.d.ts
// (registerExactEvmScheme, which is a convenience wrapper built on top of that same
// instance method). See the header comment in src/upi-scheme-client.ts for full detail.

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load the monorepo's single root .env (see "Consolidate to single root
// .env") -- this file lives at x402-upi-client/test, so the repo root is two
// levels up. Must run before MERCHANT_URL/DEMO_PAYER_VPA are read below.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerUpiScheme } from "../src/index";

const MERCHANT_BASE_URL = process.env.MERCHANT_URL ?? "http://localhost:3001";
const RESOURCE_URL = `${MERCHANT_BASE_URL}/api/premium-data`;

async function main(): Promise<void> {
  const probe = await fetch(RESOURCE_URL).catch(() => undefined);
  if (!probe || probe.status !== 402) {
    console.error(
      `Merchant server not reachable at ${RESOURCE_URL}, or not returning 402 — is the stack running?`,
    );
    process.exit(1);
  }

  const client = new x402Client();
  client.setSpendControls({ allowedAssets: true });
  registerUpiScheme(client, {
    payerVpa: process.env.DEMO_PAYER_VPA,
    agentMetadata: {
      taskContext: process.env.DEMO_TASK_CONTEXT ?? "Fetching premium data on behalf of the user",
    },
  });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  const response = await fetchWithPayment(RESOURCE_URL);
  const body = await response.text();

  console.log("status:", response.status);
  console.log("headers:");
  for (const [key, value] of response.headers.entries()) {
    console.log(`  ${key}: ${value}`);
  }
  console.log("body:", body);

  if (response.status !== 200) {
    console.error(`Demo failed: expected 200 from ${RESOURCE_URL}, got ${response.status}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Demo failed:", error);
  process.exit(1);
});
