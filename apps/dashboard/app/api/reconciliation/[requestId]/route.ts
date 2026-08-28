/**
 * GET /api/reconciliation/:requestId -- proxies to the facilitator's
 * `GET /reconciliation/:requestId` (apps/facilitator/src/server.ts), which
 * reads the durable audit trail apps/facilitator/src/store/db.ts's
 * writeReconciliationRecord writes once a request reaches a terminal
 * outcome (settled|failed).
 *
 * Exists because this dashboard's live event stream
 * (fiat402:events / fiat402:events:recent) is a rolling, bounded 200-entry
 * buffer: once the "pending" event carrying aiRecommendation/
 * aiSemanticMatch/etc. scrolls out of that window (or the browser tab is
 * reopened after it already has), there is no other way to recover that
 * data -- see app/page.tsx's postgres-fallback effect, the only caller of
 * this route.
 *
 * Uses FACILITATOR_URL (apps/merchant/lib/x402-middleware.ts's
 * callFacilitator already reads the same env var from the shared root
 * .env, loaded here via next.config.ts). Not a literal import of
 * callFacilitator -- that function lives in a different app/package with
 * no shared lib between them, and is POST/JSON-body-shaped for /verify and
 * /settle, not this GET -- but this mirrors its exact defensive shape: read
 * a non-OK response as text (never .json() it -- see that file's
 * doc comment on why: a 429/5xx body is frequently plain text, not JSON,
 * and callFacilitator has already stepped on that raw SyntaxError once),
 * and wrap a 2xx body's .json() in try/catch too, so a facilitator hiccup
 * here becomes a clean error response, never an unhandled exception.
 */

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ requestId: string }> }): Promise<Response> {
  const { requestId } = await params;
  const baseUrl = process.env.FACILITATOR_URL ?? "";

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/reconciliation/${encodeURIComponent(requestId)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `facilitator unreachable: ${message}` }, { status: 502 });
  }

  if (res.status === 404) {
    return Response.json({ error: "no reconciliation record for this requestId" }, { status: 404 });
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "<unreadable body>");
    return Response.json({ error: `facilitator request failed with status ${res.status}: ${bodyText}` }, { status: 502 });
  }

  try {
    const record: unknown = await res.json();
    return Response.json(record);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `facilitator response body was not valid JSON: ${message}` }, { status: 502 });
  }
}
