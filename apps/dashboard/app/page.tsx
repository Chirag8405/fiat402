"use client";

/**
 * Composes the five panels over a poll loop against /api/events (see that
 * route's top-of-file comment) -- replaces the former EventSource connection
 * to /api/stream (deleted; a held-open SSE connection didn't fit Vercel's
 * serverless model reliably). Polling lifecycle:
 *   - Every POLL_INTERVAL_MS, fetch /api/events?since=<cursor>, where
 *     `cursor` starts null (first poll fetches whatever's currently
 *     buffered) and is then set to the response's own `cursor` field.
 *   - A successful poll -> "polling" status with a lastPolledAt timestamp,
 *     visible on ConnectionIndicator.
 *   - A failed poll (network error or non-OK response) -> "connection-issue"
 *     status; the loop keeps retrying on the same interval regardless.
 *   - Each event within a batch: parse JSON, validate the FiatEvent shape,
 *     validate `state` is known before deriving anything from it; an unknown
 *     state is console.warn'd and otherwise dropped here (each panel that
 *     touches `state` -- StateMachineViz in particular -- has its own
 *     belt-and-suspenders guard too).
 *
 * `fiat402:events` now optionally carries decision-layer fields
 * (aiRecommendation/aiJustification/aiProvider/deterministicDecision/
 * deterministicReason) on the "pending" transition event -- see
 * apps/facilitator/src/ws.ts's FiatEvent and
 * apps/facilitator/src/server.ts's settlePayment. deriveDecision below pulls
 * those off the most recent "pending" event actually observed for the
 * current request; RawTrafficViewer's top-of-file comment still applies for
 * the raw header fields that schema does not carry.
 */

import { useEffect, useState } from "react";
import { ConnectionIndicator, type ConnectionStatus } from "../components/ConnectionIndicator";
import { RawTrafficViewer } from "../components/RawTrafficViewer";
import { UpiCollectCard } from "../components/UpiCollectCard";
import { StateMachineViz } from "../components/StateMachineViz";
import { DecisionPanel, type DeterministicDecision, type AiAdvisory } from "../components/DecisionPanel";
import { ReconciliationRecord, type ObservedTimestamps } from "../components/ReconciliationRecord";
import { isFiatEventShape, isKnownState, type FiatEvent } from "../lib/events";

const POLL_INTERVAL_MS = 2500;

interface RequestTrail {
  requestId: string;
  events: FiatEvent[];
}

interface EventsResponse {
  events: unknown[];
  cursor: string;
}

function emptyTimestamps(): ObservedTimestamps {
  return { pendingAt: null, resolvedAt: null, settledAt: null, failedAt: null };
}

/**
 * Timestamps built purely from events actually observed live for this
 * request. Mirrors apps/facilitator/src/server.ts's settlePayment
 * resolution semantics: `resolvedAt` tracks the latest "approved" event (an
 * earlier "declined" does not resolve the wait -- see
 * packages/scheme-upi/src/state-machine.ts's awaitResolution and the UPI
 * retry edge case in CLAUDE.md), falling back to the terminal event's own
 * timestamp when no "approved" was ever observed (the timeout path).
 */
function deriveTimestamps(events: FiatEvent[]): ObservedTimestamps {
  const timestamps = emptyTimestamps();
  for (const event of events) {
    if (event.state === "pending" && !timestamps.pendingAt) timestamps.pendingAt = event.timestamp;
    if (event.state === "approved") timestamps.resolvedAt = event.timestamp;
    if (event.state === "settled") {
      timestamps.settledAt = event.timestamp;
      if (!timestamps.resolvedAt) timestamps.resolvedAt = event.timestamp;
    }
    if (event.state === "failed") {
      timestamps.failedAt = event.timestamp;
      if (!timestamps.resolvedAt) timestamps.resolvedAt = event.timestamp;
    }
  }
  return timestamps;
}

interface Decision {
  deterministic: DeterministicDecision | null;
  ai: AiAdvisory | null;
}

/**
 * Pulls the decision-layer fields off the most recent "pending" event that
 * carries them -- see apps/facilitator/src/server.ts's settlePayment, which
 * attaches them only to the created->pending transition. Requests that were
 * rejected before ever reaching "pending" (deterministic reject, AI
 * hold-pending-review) never publish any event at all -- see
 * DecisionPanel.tsx's top-of-file comment -- so there is nothing to derive
 * for those, and both fields stay null.
 */
function deriveDecision(events: FiatEvent[]): Decision {
  const decisionEvent = [...events].reverse().find(event => event.state === "pending" && event.aiRecommendation !== undefined);
  if (!decisionEvent) return { deterministic: null, ai: null };

  const deterministic: DeterministicDecision | null =
    decisionEvent.deterministicDecision !== undefined
      ? { allowed: decisionEvent.deterministicDecision === "allowed", reason: decisionEvent.deterministicReason }
      : null;

  const ai: AiAdvisory | null =
    decisionEvent.aiRecommendation !== undefined
      ? {
          recommendation: decisionEvent.aiRecommendation,
          justification: decisionEvent.aiJustification ?? "",
          provider: decisionEvent.aiProvider ?? "",
        }
      : null;

  return { deterministic, ai };
}

export default function DashboardPage() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [latestEvent, setLatestEvent] = useState<FiatEvent | null>(null);
  const [trail, setTrail] = useState<RequestTrail | null>(null);

  useEffect(() => {
    let cancelled = false;
    let cursor: string | null = null;

    function applyEvent(parsed: FiatEvent): void {
      setLatestEvent(parsed);
      setTrail(prev => {
        if (!prev || prev.requestId !== parsed.requestId) {
          return { requestId: parsed.requestId, events: [parsed] };
        }
        return { requestId: prev.requestId, events: [...prev.events, parsed] };
      });
    }

    async function poll(): Promise<void> {
      try {
        const url = cursor ? `/api/events?since=${encodeURIComponent(cursor)}` : "/api/events";
        const response = await fetch(url);
        if (!response.ok) throw new Error(`poll failed with status ${response.status}`);

        const data = (await response.json()) as EventsResponse;
        if (cancelled) return;

        cursor = data.cursor;
        setStatus("polling");
        setLastPolledAt(new Date().toISOString());

        for (const raw of data.events) {
          if (!isFiatEventShape(raw)) continue;
          if (!isKnownState(raw.state)) {
            console.warn(`page: received unrecognized state "${raw.state}" for request ${raw.requestId}; ignoring`);
            continue;
          }
          applyEvent(raw);
        }
      } catch (err) {
        if (!cancelled) setStatus("connection-issue");
        console.warn("page: poll against /api/events failed", err);
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const events = trail?.events ?? [];
  const requestId = trail?.requestId ?? null;
  const current = events[events.length - 1] ?? null;
  const paymentLinkId = [...events].reverse().find(event => event.meta.paymentLinkId)?.meta.paymentLinkId ?? null;
  const razorpayPaymentId = [...events].reverse().find(event => event.meta.razorpayPaymentId)?.meta.razorpayPaymentId ?? null;
  const finalOutcome = current?.state === "settled" || current?.state === "failed" ? current.state : null;
  const { deterministic, ai } = deriveDecision(events);

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">fiat402 control tower</h1>
          <p className="text-xs text-muted-foreground">Polling view over the fiat402:events Redis channel</p>
        </div>
        <ConnectionIndicator status={status} lastPolledAt={lastPolledAt} />
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <StateMachineViz event={latestEvent} />
        <UpiCollectCard requestId={requestId} state={current?.state ?? null} paymentLinkId={paymentLinkId} />
        <DecisionPanel requestId={requestId} deterministic={deterministic} ai={ai} />
        <ReconciliationRecord
          requestId={requestId}
          finalOutcome={finalOutcome}
          razorpayPaymentId={razorpayPaymentId}
          paymentLinkId={paymentLinkId}
          timestamps={deriveTimestamps(events)}
          deterministic={deterministic}
          ai={ai}
        />
      </div>

      <RawTrafficViewer requestId={requestId} paymentRequiredHeader={null} paymentSignatureHeader={null} paymentResponseHeader={null} />
    </main>
  );
}
