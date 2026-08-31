/**
 * POST /api/console/export/:requestId -- bundles the three replay-fixture
 * sources into exactly the shape the scrollytelling page's recorded-demo
 * replay will consume. Gated by middleware.ts (same passcode cookie as
 * /console) via the /api/console/:path* matcher.
 *
 * Source reachability, confirmed per source (this is what determined this
 * route's interface):
 *   - FiatEvent[] (fiat402:events:recent) -- server-reachable, read directly
 *     off this app's own Redis client (../../../../../lib/redis), same list
 *     app/api/events/route.ts polls.
 *   - Reconciliation record -- server-reachable via the facilitator's GET
 *     /reconciliation/:requestId, proxied the same defensive way as
 *     app/api/reconciliation/[requestId]/route.ts. Comes back `null` (not an
 *     error) when the request hasn't reached a terminal outcome yet -- e.g.
 *     capturing a timeout run, which by definition never writes this record.
 *   - paymentResponseHeader -- server-reachable: app/api/simulate/route.ts's
 *     deferred after() call persists it to this app's own Redis, keyed by
 *     razorpayPaymentId (see lib/simulate-payment-response.ts). Read directly
 *     here once razorpayPaymentId is known (from the reconciliation record,
 *     or failing that, the most recent event carrying meta.razorpayPaymentId).
 *   - paymentRequiredHeader / paymentSignatureHeader -- NOT server-reachable.
 *     app/page.tsx (soon app/console/page.tsx) only ever writes these into
 *     the BROWSER's own sessionStorage, key
 *     `fiat402:simulate-headers:{requestId}` -- see that file's
 *     SIMULATE_HEADERS_PENDING_KEY doc comment. There is no server-side copy
 *     to read. So this route accepts them as an optional JSON request body
 *     instead: the caller reads
 *     `sessionStorage.getItem(\`fiat402:simulate-headers:${requestId}\`)`
 *     itself (it's already JSON: `{ paymentRequiredHeader, paymentSignatureHeader }`)
 *     and POSTs it here alongside an optional `persona` string (which
 *     persona button was clicked -- also not derivable server-side, since no
 *     FiatEvent field carries it). All three are optional; omitted fields
 *     come back `null` in the response rather than being fabricated.
 */

import { redisClient } from "../../../../../lib/redis";
import { EVENTS_RECENT_LIST, type FiatEvent, type ReconciliationRecordDto } from "../../../../../lib/types";
import { isFiatEventShape } from "../../../../../lib/events";
import { paymentResponseKey } from "../../../../../lib/simulate-payment-response";

export const runtime = "nodejs";

interface ClientSuppliedExtras {
  paymentRequiredHeader?: string;
  paymentSignatureHeader?: string;
  persona?: string;
}

function parseListItem(item: unknown): FiatEvent | null {
  let candidate: unknown = item;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return isFiatEventShape(candidate) ? candidate : null;
}

/** Mirrors app/api/reconciliation/[requestId]/route.ts's defensive fetch shape, but returns null on any non-2xx/network issue rather than an error Response -- export should still succeed with whatever it DID find. */
async function fetchReconciliationRecord(requestId: string): Promise<ReconciliationRecordDto | null> {
  const baseUrl = process.env.FACILITATOR_URL ?? "";
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/reconciliation/${encodeURIComponent(requestId)}`);
  } catch (err) {
    console.warn(`console/export: facilitator unreachable fetching reconciliation for ${requestId} (non-fatal)`, err);
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`console/export: reconciliation fetch for ${requestId} failed with status ${res.status} (non-fatal)`);
    return null;
  }
  try {
    return (await res.json()) as ReconciliationRecordDto;
  } catch (err) {
    console.warn(`console/export: reconciliation response for ${requestId} was not valid JSON (non-fatal)`, err);
    return null;
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ requestId: string }> }): Promise<Response> {
  const { requestId } = await params;

  let clientExtras: ClientSuppliedExtras = {};
  const contentLength = request.headers.get("content-length");
  if (contentLength && contentLength !== "0") {
    try {
      clientExtras = (await request.json()) as ClientSuppliedExtras;
    } catch {
      return Response.json({ error: "request body must be JSON" }, { status: 400 });
    }
  }

  const raw = await redisClient.lrange<unknown>(EVENTS_RECENT_LIST, 0, 199);
  const events = raw
    .map(parseListItem)
    .filter((event): event is FiatEvent => event !== null && event.requestId === requestId)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  if (events.length === 0) {
    return Response.json(
      {
        error: `no events found for requestId "${requestId}" in fiat402:events:recent -- it may have aged out of the 200-entry window, or never existed`,
      },
      { status: 404 },
    );
  }

  const reconciliation = await fetchReconciliationRecord(requestId);

  const razorpayPaymentId =
    reconciliation?.razorpayPaymentId ??
    [...events].reverse().find(event => event.meta.razorpayPaymentId)?.meta.razorpayPaymentId ??
    null;

  let paymentResponseHeader: string | null = null;
  if (razorpayPaymentId) {
    try {
      paymentResponseHeader = (await redisClient.get<string>(paymentResponseKey(razorpayPaymentId))) ?? null;
    } catch (err) {
      console.warn(`console/export: failed to read PAYMENT-RESPONSE for ${razorpayPaymentId} (non-fatal)`, err);
    }
  }

  return Response.json({
    requestId,
    persona: clientExtras.persona ?? null,
    events,
    reconciliation,
    headers: {
      paymentRequiredHeader: clientExtras.paymentRequiredHeader ?? null,
      paymentSignatureHeader: clientExtras.paymentSignatureHeader ?? null,
      paymentResponseHeader,
    },
  });
}
