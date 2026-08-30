/**
 * POST /api/simulate -- triggers a real agent payment request from the
 * dashboard itself, so the full demo (trigger -> agent console -> rail ->
 * decision -> confirm/decline/pay -> settle) happens in one browser tab. This
 * is the same protocol path x402-upi-client/test/demo.ts already exercises
 * from a terminal: probe the merchant's protected resource for a 402, then
 * let `wrapFetchWithPayment` retry it with a UPI PaymentPayload attached,
 * which flows through apps/merchant/lib/x402-middleware.ts unchanged.
 *
 * Body: `{ persona: "researchbot" | "travelbot" }`. Two fixed personas
 * mirroring demo.ts's clean-approve and mismatch (--mismatch) cases:
 *   - researchbot: task matches the merchant's declared item -> clean-approve
 *   - travelbot: the existing deliberately-unrelated taskContext -> hold
 *
 * CRITICAL structural constraint this route is built around: a "hold" can
 * block for up to `maxTimeoutSeconds` (currently 180s, see
 * apps/merchant/lib/x402-middleware.ts's buildUpiRequirements) inside a
 * single chain of blocking awaits -- this route's fetch to the merchant
 * blocks on the merchant's own fetch to the facilitator's /settle, which
 * blocks inside settlePayment for up to that long. There is no way to get an
 * early return from *inside* that chain without changing merchant/facilitator
 * behavior (out of scope here) -- the split has to happen before the long
 * call starts:
 *
 *   1. The genuinely fast, real pre-payment steps (the plain probe fetch
 *      demo.ts already does separately, then constructing the x402Client +
 *      UpiSchemeClient) run here synchronously and are streamed to the
 *      browser as NDJSON lines as they actually happen -- see AgentConsole.tsx,
 *      which reads this stream. This closes in ~1-2s regardless of what
 *      happens next, so it never risks Vercel's function-duration limits the
 *      way holding the connection for the full settle wait would.
 *   2. Right before the one call that CAN take up to 180s
 *      (`fetchWithPayment(RESOURCE_URL)`, which triggers the merchant->
 *      facilitator round trip), this route emits a final "handed off" line,
 *      closes the stream, and hands that call to `after()` (next/server,
 *      stable since Next 15) so it keeps running in the background after the
 *      HTTP response has already finished -- unlike a bare fire-and-forget
 *      promise, which Vercel can freeze once a response is sent, `after()` is
 *      the documented mechanism for exactly this. Requires Fluid Compute
 *      enabled on the Vercel project (confirmed) and `maxDuration` below
 *      sized for the worst case.
 *
 * No requestId is threaded through any of this: UpiSchemeClient never sets a
 * `txnRef` (see packages/scheme-upi/src/state-machine.ts's deriveRequestId --
 * absent a client-supplied txnRef, the facilitator mixes in a random UUID),
 * so the requestId this simulated call will produce is not knowable ahead of
 * time without changing that shared scheme-client package. The dashboard
 * doesn't need it anyway: app/page.tsx's existing poll loop against
 * /api/events already picks up whatever happens next by simply noticing a
 * new requestId, exactly as it does when demo.ts is run from a terminal --
 * AgentConsole hands off to the existing rail/DecisionPanel on that same
 * basis, not by tracking a specific id.
 */

import { after } from "next/server";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerUpiScheme } from "@fiat402/x402-upi-client";

export const runtime = "nodejs";
// Sized for the worst case (a hold that rides out the full 180s
// maxTimeoutSeconds inside settlePayment) plus a buffer -- this is the
// background `after()` work's budget, not the streamed response's, which
// closes in ~1-2s. Requires Fluid Compute (confirmed enabled) for `after()`
// to actually get this much wall-clock time post-response.
export const maxDuration = 200;

interface Persona {
  label: string;
  taskContext: string;
}

const PERSONAS: Record<string, Persona> = {
  researchbot: { label: "ResearchBot", taskContext: "Fetch premium market data for client report" },
  travelbot: { label: "TravelBot", taskContext: "Booking a one-way flight to Goa" },
};

type LineKind = "info" | "success" | "error";

function isPersonaKey(value: unknown): value is keyof typeof PERSONAS {
  return typeof value === "string" && value in PERSONAS;
}

/**
 * Runs the one call that can genuinely take up to `maxTimeoutSeconds`.
 * Deliberately has no return value the caller can observe -- by the time
 * this runs (inside `after()`), the HTTP response is already closed. Errors
 * are logged, never thrown: an unhandled rejection here has nowhere to go.
 */
async function runPaymentFlow(resourceUrl: string, client: x402Client, persona: string): Promise<void> {
  try {
    const fetchWithPayment = wrapFetchWithPayment(fetch, client);
    const response = await fetchWithPayment(resourceUrl);
    console.log(`[simulate:${persona}] payment flow completed with status ${response.status}`);
  } catch (err) {
    console.error(`[simulate:${persona}] payment flow failed:`, err);
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "request body must be JSON" }, { status: 400 });
  }

  const personaKey = (body as { persona?: unknown } | null)?.persona;
  if (!isPersonaKey(personaKey)) {
    return Response.json({ error: `persona must be one of: ${Object.keys(PERSONAS).join(", ")}` }, { status: 400 });
  }
  const persona = PERSONAS[personaKey];

  const merchantBaseUrl = process.env.MERCHANT_URL ?? "";
  const resourceUrl = `${merchantBaseUrl}/api/premium-data`;

  const encoder = new TextEncoder();
  // Definite-assignment: `start` runs synchronously during `new
  // ReadableStream(...)` construction below, so this is always assigned
  // before any of the code that reads it runs -- TS can't see that across
  // the constructor boundary.
  let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
  });

  function emit(line: string, kind: LineKind = "info"): void {
    controllerRef.enqueue(encoder.encode(`${JSON.stringify({ line, kind })}\n`));
  }

  // Drives the stream. Not awaited here -- returning the Response below is
  // what actually starts delivering these chunks to the browser; this IIFE
  // just produces them as the real steps below actually complete.
  void (async () => {
    try {
      emit(`${persona.label}: requesting protected resource...`);
      const probe = await fetch(resourceUrl).catch((err: unknown) => {
        throw new Error(`merchant unreachable at ${resourceUrl}: ${err instanceof Error ? err.message : String(err)}`);
      });
      if (probe.status !== 402) {
        emit(`unexpected response from merchant: status ${probe.status} (expected 402)`, "error");
        controllerRef.close();
        return;
      }
      emit("402 Payment Required received from merchant", "success");

      emit(`constructing UPI payment payload (task: "${persona.taskContext}")...`);
      const client = new x402Client();
      client.setSpendControls({ allowedAssets: true });
      // @fiat402/x402-upi-client is a `file:` dependency with its own
      // independent `node_modules/@x402/core` (this repo has no root
      // workspace to hoist/dedupe against -- see this app's own
      // next.config.ts comment on why every app installs independently).
      // That means `registerUpiScheme`'s declared `client: x402Client`
      // parameter is nominally a different type than the one just
      // constructed above from *this* app's own `@x402/core` install, even
      // though both resolve the identical package version and are
      // structurally and behaviorally identical at runtime -- the mismatch
      // TypeScript catches here is purely the private-field brand check
      // that comes from having two physically separate installs, not a real
      // incompatibility. Cast at this one boundary rather than restructuring
      // the repo into a workspace to dedupe it.
      registerUpiScheme(client as unknown as Parameters<typeof registerUpiScheme>[0], {
        payerVpa: process.env.DEMO_PAYER_VPA,
        agentMetadata: { taskContext: persona.taskContext },
      });

      emit("sending payment payload to facilitator via merchant -- watch the rail below");
      controllerRef.close();

      after(() => runPaymentFlow(resourceUrl, client, personaKey));
    } catch (err) {
      emit(err instanceof Error ? err.message : String(err), "error");
      controllerRef.close();
    }
  })();

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}
