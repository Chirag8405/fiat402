/**
 * POST /api/decline/:requestId -- proxies to the facilitator's
 * `POST /internal/decline/:requestId` (apps/facilitator/src/server.ts),
 * which publishes a human-decline signal that unblocks whichever bounded
 * wait (awaitConfirmGate for a still-unconfirmed hold, or the
 * resolutionPromise/awaitDeclineSignal race for the payer-approval wait) is
 * currently holding that request's /settle call open -- see
 * apps/facilitator/src/confirm-gate.ts's declineConfirmGate.
 *
 * Symmetric to ../../confirm-gate/[requestId]/route.ts: same reason for
 * existing (the browser never sees CONFIRM_GATE_SECRET), same
 * unset-secret-means-unauthenticated fallback, same defensive fetch shape
 * (non-OK read as text, network failure becomes a clean 502). Decline is
 * available whenever state === "pending", not gated to a "hold"
 * recommendation the way Confirm is -- that distinction lives in
 * DecisionPanel.tsx, not here; this route has no opinion on when it's
 * appropriate to call it.
 */

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ requestId: string }> }): Promise<Response> {
  const { requestId } = await params;
  const baseUrl = process.env.FACILITATOR_URL ?? "";
  const secret = process.env.CONFIRM_GATE_SECRET;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/internal/decline/${encodeURIComponent(requestId)}`, {
      method: "POST",
      headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `facilitator unreachable: ${message}` }, { status: 502 });
  }

  if (res.status === 401) {
    return Response.json({ error: "decline request was unauthorized (CONFIRM_GATE_SECRET mismatch)" }, { status: 401 });
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "<unreadable body>");
    return Response.json({ error: `facilitator request failed with status ${res.status}: ${bodyText}` }, { status: 502 });
  }

  return Response.json({ ok: true });
}
