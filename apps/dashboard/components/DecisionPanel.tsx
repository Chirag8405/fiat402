"use client";

/**
 * Shows the deterministic policy decision and the AI advisory recommendation
 * side by side, per CLAUDE.md's "Deterministic policy engine" / "AI advisory
 * layer" sections and apps/facilitator/src/server.ts's verifyPayment (which
 * returns `{ isValid, invalidReason, extra: { aiRecommendation,
 * aiJustification, aiProvider } }`).
 *
 * That decision data is returned in the /verify HTTP response body -- it is
 * never published to `fiat402:events` (FiatEvent only carries
 * requestId/state/previousState/timestamp/meta.{paymentLinkId,
 * razorpayPaymentId,reason}; see apps/facilitator/src/server.ts's
 * settlePayment: the deterministic-reject and AI-hold-pending-review early
 * returns both happen before any transitionState/publishEvent call, so
 * those outcomes never reach the pub/sub channel this dashboard's SSE relay
 * subscribes to at all). Per this module's brief to build strictly against
 * that event shape, app/page.tsx has no live source for these fields and
 * passes `null` -- this panel renders a clear "not available on the live
 * event stream" state in that case rather than fabricating data.
 */

import { EmptyState } from "./EmptyState";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";

export interface DeterministicDecision {
  allowed: boolean;
  reason?: string;
}

export interface AiAdvisory {
  recommendation: "approve" | "hold" | "flag" | string;
  justification: string;
  provider: string;
}

export interface DecisionPanelProps {
  requestId: string | null;
  deterministic: DeterministicDecision | null;
  ai: AiAdvisory | null;
}

/** Per CLAUDE.md: AI never overrides the deterministic gate. Divergence here just means it added friction the deterministic engine didn't require. */
function isDivergent(deterministic: DeterministicDecision, ai: AiAdvisory): boolean {
  return deterministic.allowed && ai.recommendation !== "approve";
}

export function DecisionPanel({ requestId, deterministic, ai }: DecisionPanelProps) {
  const divergent = deterministic && ai ? isDivergent(deterministic, ai) : false;
  const failClosed = ai?.provider === "fail-closed";

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
          <div className={cn("grid grid-cols-2 gap-3 rounded-lg p-2 transition-colors", divergent && "bg-warning/10 ring-1 ring-warning/40")}>
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
                    <Badge variant={failClosed ? "warning" : "muted"} className={failClosed ? "animate-pulse" : undefined}>
                      {failClosed ? "⚠ fail-closed" : ai.provider}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{ai.justification}</p>
                </>
              ) : (
                <EmptyState>no data</EmptyState>
              )}
            </div>
            {divergent && (
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
