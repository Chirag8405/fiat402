"use client";

/**
 * Section 6 -- two copy-button code blocks. Both snippets are copied
 * VERBATIM from the actual working source files (CLAUDE.md's "don't invent
 * field names/shapes" discipline) -- not reconstructed from memory:
 *   - "For merchants": apps/merchant/app/api/premium-data/route.ts, the
 *     real withX402Payment(...) call site.
 *   - "For agents": x402-upi-client/src/index.ts's registerUpiScheme (the
 *     one place in this repo `client.register("upi:in", new
 *     UpiSchemeClient(...))` exists as real, executable code -- every real
 *     caller, including the one below, goes through this wrapper rather
 *     than writing that line out directly) plus the real call-site usage
 *     from x402-upi-client/test/demo.ts.
 */

import { CodeBlock } from "./CodeBlock";

const MERCHANT_SNIPPET = `import { withX402Payment } from "../../../lib/x402-middleware";

export async function GET(request: Request): Promise<Response> {
  return withX402Payment(request, RESOURCE, () =>
    Response.json({
      data: "premium market data",
      generatedAt: new Date().toISOString(),
    }),
  );
}`;

const AGENT_SNIPPET = `// x402-upi-client/src/index.ts
export function registerUpiScheme(client: x402Client, options?: UpiSchemeClientOptions): x402Client {
  return client.register("upi:in", new UpiSchemeClient(options));
}

// real usage (x402-upi-client/test/demo.ts):
const client = new x402Client();
client.setSpendControls({ allowedAssets: true });
registerUpiScheme(client, {
  payerVpa: process.env.DEMO_PAYER_VPA,
  agentMetadata: { taskContext },
});`;

export function CodeSection() {
  return (
    <section className="relative bg-background px-6 py-24">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">the actual protocol</p>
          <h2 className="mt-1 text-2xl font-semibold text-foreground sm:text-3xl">Two lines, either side</h2>
        </div>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <CodeBlock label="For merchants" code={MERCHANT_SNIPPET} />
          <CodeBlock label="For agents" code={AGENT_SNIPPET} />
        </div>
      </div>
    </section>
  );
}
