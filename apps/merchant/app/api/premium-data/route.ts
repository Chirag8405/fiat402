/**
 * GET /api/premium-data -- a small protected resource gated behind the x402
 * "upi" scheme via lib/x402-middleware.ts's withX402Payment. See that file's
 * top-of-file comment for the full 402/200 header contract.
 */

import { withX402Payment } from "../../../lib/x402-middleware";

export const runtime = "nodejs";

const RESOURCE = {
  url: "/api/premium-data",
  description: "Premium data access",
  mimeType: "application/json",
  serviceName: "fiat402 merchant demo",
};

export async function GET(request: Request): Promise<Response> {
  return withX402Payment(request, RESOURCE, () =>
    Response.json({
      data: "premium market data",
      generatedAt: new Date().toISOString(),
    }),
  );
}
