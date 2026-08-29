/**
 * POST /api/confirm-gate/:requestId -- proxies to the facilitator's
 * `POST /internal/confirm-gate/:requestId` (apps/facilitator/src/server.ts),
 * which satisfies the confirm-gate a held/flagged settlement is bounded-
 * waiting on (see apps/facilitator/src/confirm-gate.ts's satisfyConfirmGate).
 *
 * Exists so the browser never sees CONFIRM_GATE_SECRET: that route is guarded
 * by a shared bearer secret since it lets any caller unblock a held
 * settlement (see server.ts's own doc comment on that route). This route
 * reads CONFIRM_GATE_SECRET server-side only (from the shared root .env,
 * loaded via next.config.ts, same mechanism as FACILITATOR_URL) and attaches
 * it as an Authorization header -- the browser only ever calls this same-
 * origin route with no secret involved.
 *
 * If CONFIRM_GATE_SECRET is unset here, no Authorization header is sent at
 * all -- this mirrors the facilitator's own unset-secret behavior (serves the
 * route unauthenticated, with a startup warning) rather than inventing a
 * different failure mode on this side.
 *
 * Mirrors app/api/reconciliation/[requestId]/route.ts's defensive fetch shape:
 * a non-OK response is read as text, never blind-.json()'d (a 429/5xx body is
 * frequently plain text), and network failures become a clean 502 rather than
 * an unhandled exception.
 */

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ requestId: string }> }): Promise<Response> {
  const { requestId } = await params;
  const baseUrl = process.env.FACILITATOR_URL ?? "";
  const secret = process.env.CONFIRM_GATE_SECRET;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/internal/confirm-gate/${encodeURIComponent(requestId)}`, {
      method: "POST",
      headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `facilitator unreachable: ${message}` }, { status: 502 });
  }

  if (res.status === 401) {
    return Response.json({ error: "confirm-gate request was unauthorized (CONFIRM_GATE_SECRET mismatch)" }, { status: 401 });
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "<unreadable body>");
    return Response.json({ error: `facilitator request failed with status ${res.status}: ${bodyText}` }, { status: 502 });
  }

  return Response.json({ ok: true });
}
