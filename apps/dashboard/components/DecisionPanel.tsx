"use client";

/**
 * Shows the deterministic policy decision and the AI advisory recommendation
 * side by side, per CLAUDE.md's "Deterministic policy engine" / "AI advisory
 * layer" sections and apps/facilitator/src/server.ts's verifyPayment (which
 * returns `{ isValid, invalidReason, extra: { aiRecommendation,
 * aiJustification, aiProvider } }`).
 *
 * That decision data is also attached to the "pending" transition's
 * FiatEvent (aiRecommendation/aiJustification/aiProvider/
 * deterministicDecision/deterministicReason -- see
 * apps/facilitator/src/ws.ts's FiatEvent and
 * apps/facilitator/src/server.ts's settlePayment), so app/page.tsx derives
 * it live from the event stream for any request that reaches "pending".
 * A request rejected before "pending" (deterministic reject, or an
 * AI hold/flag still waiting on the confirm-gate) never publishes an event
 * at all -- those outcomes only ever appear in the /verify or /settle HTTP
 * response body, never on `fiat402:events` -- so this panel still renders
 * the "not available on the live event stream" state for those, rather than
 * fabricating data.
 *
 * Confirm action: when the request is genuinely blocked on a human decision
 * (isPendingHold -- see lib/confirm-gate.ts), this panel renders a Confirm
 * button that POSTs to /api/confirm-gate/:requestId (a same-origin proxy that
 * holds CONFIRM_GATE_SECRET server-side -- see that route's top-of-file
 * comment). Confirming does not itself move money: it only satisfies the
 * facilitator's bounded wait so settlePayment's already-running
 * awaitResolution can keep waiting on the Payment Link the payer still has to
 * pay. The other valid way to satisfy the same gate is the payer paying the
 * Payment Link directly (apps/facilitator/src/razorpay/webhook-handler.ts
 * also calls satisfyConfirmGate on payment_link.paid/payment.captured) --
 * that path needs no dashboard action at all, since it just moves `state`
 * off "pending" on the next poll.
 */

import { useEffect, useState } from "react";
import { EmptyState } from "./EmptyState";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";
import { isPendingHold } from "../lib/confirm-gate";
import type { RequestState } from "../lib/events";

export interface DeterministicDecision {
  allowed: boolean;
  reason?: string;
}

export interface AiAdvisory {
  recommendation: "approve" | "hold" | "flag" | string;
  justification: string;
  provider: string;
  /** True/false when the facilitator's advisory layer judged agent intent against declared merchant intent; absent for records with no semantic-match data (e.g. older reconciliation rows). */
  semanticMatch?: boolean;
  /** Technical/log-facing rationale -- separate audience from `justification`'s human-facing summary. Rendered behind a "Why" disclosure, not inline. */
  reasoning?: string;
}

export interface DecisionPanelProps {
  requestId: string | null;
  state: RequestState | null;
  deterministic: DeterministicDecision | null;
  ai: AiAdvisory | null;
}

/** Per CLAUDE.md: AI never overrides the deterministic gate. Divergence here just means it added friction the deterministic engine didn't require. */
function isDivergent(deterministic: DeterministicDecision, ai: AiAdvisory): boolean {
  return deterministic.allowed && ai.recommendation !== "approve";
}

type ConfirmPhase = "idle" | "confirming" | "confirmed" | "error";

function ConfirmButton({ requestId }: { requestId: string }) {
  const [phase, setPhase] = useState<ConfirmPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset whenever the request being shown changes -- a stale "confirmed"
  // label must never carry over onto a different request's hold.
  useEffect(() => {
    setPhase("idle");
    setErrorMessage(null);
  }, [requestId]);

  async function handleConfirm(): Promise<void> {
    setPhase("confirming");
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/confirm-gate/${encodeURIComponent(requestId)}`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setErrorMessage(body?.error ?? `request failed with status ${res.status}`);
        setPhase("error");
        return;
      }
      setPhase("confirmed");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  const label = phase === "confirming" ? "Confirming…" : phase === "confirmed" ? "Confirmed — waiting for payment" : "Confirm";
  const disabled = phase === "confirming" || phase === "confirmed";

  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={() => void handleConfirm()}
        disabled={disabled}
        className={cn(
          "rounded-full px-5 py-2 text-sm font-semibold",
          "transition-[transform,opacity,background-color] duration-150 ease-[var(--ease-out)]",
          "active:scale-[0.97]",
          phase === "confirmed"
            ? "border border-success/50 bg-success/10 text-success"
            : "bg-primary text-primary-foreground shadow-[0_0_0_4px] shadow-primary/15 disabled:opacity-70",
        )}
      >
        <span
          className={cn("inline-block transition-[filter,opacity] duration-150 ease-[var(--ease-out)]", phase === "confirming" && "opacity-70 blur-[1.5px]")}
        >
          {label}
        </span>
      </button>
      {phase === "error" && errorMessage && <p className="text-center text-[11px] text-danger">{errorMessage} &middot; tap to retry</p>}
    </div>
  );
}

export function DecisionPanel({ requestId, state, deterministic, ai }: DecisionPanelProps) {
  const divergent = deterministic && ai ? isDivergent(deterministic, ai) : false;
  const failClosed = ai?.provider === "fail-closed";
  const normalizedRecommendation = ai?.recommendation === "hold" || ai?.recommendation === "approve" ? ai.recommendation : undefined;
  const pendingHold = requestId !== null && isPendingHold(state, normalizedRecommendation);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Decision</CardTitle>
        <CardDescription>{requestId ? `Request: ${requestId}` : "No request in flight"}</CardDescription>
      </CardHeader>
      <CardContent>
        {!deterministic && !ai ? (
          <EmptyState>
            Not available on the live event stream -- the deterministic/AI decision is returned in the facilitator&apos;s /verify
            response, not published to fiat402:events.
          </EmptyState>
        ) : (
          <div
            className={cn(
              "grid grid-cols-2 gap-3 rounded-lg p-2 transition-colors",
              divergent && !pendingHold && "bg-warning/10 ring-1 ring-warning/40",
              pendingHold && "bg-primary/5 ring-1 ring-primary/30",
            )}
          >
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">Deterministic</div>
              {deterministic ? (
                <>
                  <Badge variant={deterministic.allowed ? "success" : "danger"}>{deterministic.allowed ? "allowed" : "rejected"}</Badge>
                  {deterministic.reason && <p className="text-xs text-muted-foreground">{deterministic.reason}</p>}
                </>
              ) : (
                <EmptyState>no data</EmptyState>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">AI advisory</div>
              {ai ? (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={ai.recommendation === "approve" ? "success" : ai.recommendation === "hold" ? "warning" : "danger"}>
                      {ai.recommendation}
                    </Badge>
                    {ai.semanticMatch !== undefined && (
                      <Badge variant={ai.semanticMatch ? "success" : "danger"}>{ai.semanticMatch ? "intent match" : "intent mismatch"}</Badge>
                    )}
                    <Badge variant={failClosed ? "warning" : "muted"} className={failClosed ? "animate-pulse" : undefined}>
                      {failClosed ? "⚠ fail-closed" : ai.provider}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{ai.justification}</p>
                  {ai.reasoning && (
                    <details className="text-[11px] text-muted-foreground">
                      <summary className="cursor-pointer select-none">Why</summary>
                      <p className="mt-1 font-mono text-[10.5px] leading-relaxed">{ai.reasoning}</p>
                    </details>
                  )}
                </>
              ) : (
                <EmptyState>no data</EmptyState>
              )}
            </div>
            {pendingHold && requestId && (
              <div className="col-span-2 flex flex-col items-center gap-2 border-t border-primary/20 pt-3">
                <p className="text-center text-[11px] font-medium text-primary">
                  A human decision is needed here -- the payment is genuinely blocked server-side until this is confirmed, or the payer pays the Payment Link
                  directly.
                </p>
                <ConfirmButton requestId={requestId} />
              </div>
            )}
            {divergent && !pendingHold && (
              <div className="col-span-2 text-center text-[11px] font-medium text-warning">
                ⚠ Divergent: deterministic allowed, AI recommended {ai?.recommendation}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
