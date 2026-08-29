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
import { ReconciliationRecord, type ObservedTimestamps, type ReconciliationExtras } from "../components/ReconciliationRecord";
import { isFiatEventShape, isKnownState, type FiatEvent } from "../lib/events";
import type { ReconciliationRecordDto } from "../lib/types";

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
          semanticMatch: decisionEvent.aiSemanticMatch,
          reasoning: decisionEvent.aiReasoning,
        }
      : null;

  return { deterministic, ai };
}

/**
 * Translates a Postgres-sourced AdvisoryRecommendation ("hold"|"proceed")
 * into the live event stream's "approve"|"hold" wire vocabulary, so
 * DecisionPanel/ReconciliationRecord render identically regardless of which
 * source the data came from. Mirrors apps/facilitator/src/ws.ts's own
 * "proceed" -> "approve" shim for the same reason documented there: this
 * dashboard's UI already keys its styling off "approve".
 */
function toLiveRecommendationVocabulary(recommendation: "hold" | "proceed"): "approve" | "hold" {
  return recommendation === "proceed" ? "approve" : "hold";
}

function decisionFromReconciliationRecord(record: ReconciliationRecordDto): Decision {
  return {
    deterministic: { allowed: record.deterministicDecision, reason: record.deterministicReason ?? undefined },
    ai: record.aiRecommendation
      ? {
          recommendation: toLiveRecommendationVocabulary(record.aiRecommendation),
          justification: record.aiJustification ?? "",
          provider: record.aiProvider ?? "",
        }
      : null,
  };
}

function emptyReconciliationExtras(): ReconciliationExtras {
  return { txnRef: null, amountPaise: null, payTo: null };
}

interface PostgresFallback {
  decision: Decision;
  extras: ReconciliationExtras;
}

export default function DashboardPage() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [trail, setTrail] = useState<RequestTrail | null>(null);
  const [postgresFallback, setPostgresFallback] = useState<PostgresFallback | null>(null);

  useEffect(() => {
    let cancelled = false;
    let cursor: string | null = null;

    function applyEvent(parsed: FiatEvent): void {
      // Functional updater, deliberately: when a poll batch contains several
      // events for the same request (a fast payment can resolve
      // pending->approved->settled within one batch), React 18 batches every
      // setTrail call in this loop into a single re-render -- but a
      // functional updater still applies each call in order against the
      // running state, so `trail.events` ends up with the full sequence
      // rather than only the last event. StateMachineViz's own
      // minimum-visible-duration queue depends on receiving that full
      // sequence, not just the latest state -- see that component's
      // top-of-file comment.
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
  const liveDecision = deriveDecision(events);
  const hasLiveDecision = liveDecision.deterministic !== null || liveDecision.ai !== null;

  // Falls back to Postgres (via the facilitator's GET /reconciliation/:requestId,
  // proxied at /api/reconciliation/:requestId) once a request has reached a
  // terminal outcome AND the live event stream has no decision-layer data for
  // it -- prefer live data whenever any of it exists. This closes the gap
  // where the "pending" event carrying aiRecommendation/aiSemanticMatch/etc.
  // has scrolled out of fiat402:events:recent's bounded 200-entry window (or
  // the tab was reopened after it already had), even though a full
  // reconciliation record was durably written to Postgres once the request
  // settled/failed -- see ReconciliationRecord.tsx's top-of-file comment.
  useEffect(() => {
    if (!requestId || !finalOutcome || hasLiveDecision) {
      setPostgresFallback(null);
      return;
    }
    // Rebound to a new const: TS doesn't carry the `requestId` narrowing
    // above into the nested async function below across the closure
    // boundary, even though it's a `const` that can't have changed.
    const currentRequestId = requestId;

    let cancelled = false;

    async function fetchWithRetry(): Promise<void> {
      // Up to 3 attempts, 1s apart: a 404 here can be a real, small race,
      // not "never will exist" -- settlePayment publishes the terminal
      // FiatEvent to Redis (which is what set finalOutcome above) BEFORE
      // its writeReconciliationRecord call is awaited, so this dashboard
      // can see "settled"/"failed" a few ms before the Postgres row
      // actually exists.
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const res = await fetch(`/api/reconciliation/${encodeURIComponent(currentRequestId)}`);
          if (res.ok) {
            const record = (await res.json()) as ReconciliationRecordDto;
            if (!cancelled) {
              setPostgresFallback({
                decision: decisionFromReconciliationRecord(record),
                extras: { txnRef: record.txnRef, amountPaise: record.amountPaise, payTo: record.payTo },
              });
            }
            return;
          }
          if (res.status !== 404) {
            console.warn(`page: /api/reconciliation/${currentRequestId} failed with status ${res.status}`);
            return;
          }
        } catch (err) {
          console.warn(`page: /api/reconciliation/${currentRequestId} request failed`, err);
          return;
        }
        if (attempt < MAX_ATTEMPTS && !cancelled) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    void fetchWithRetry();
    return () => {
      cancelled = true;
    };
  }, [requestId, finalOutcome, hasLiveDecision]);

  const { deterministic, ai } = hasLiveDecision ? liveDecision : (postgresFallback?.decision ?? liveDecision);
  const reconciliationExtras = postgresFallback?.extras ?? emptyReconciliationExtras();

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
        <StateMachineViz events={events} />
        <UpiCollectCard requestId={requestId} state={current?.state ?? null} paymentLinkId={paymentLinkId} />
        <DecisionPanel requestId={requestId} state={current?.state ?? null} deterministic={deterministic} ai={ai} />
        <ReconciliationRecord
          requestId={requestId}
          finalOutcome={finalOutcome}
          razorpayPaymentId={razorpayPaymentId}
          paymentLinkId={paymentLinkId}
          timestamps={deriveTimestamps(events)}
          deterministic={deterministic}
          ai={ai}
          extras={reconciliationExtras}
        />
      </div>

      <RawTrafficViewer requestId={requestId} paymentRequiredHeader={null} paymentSignatureHeader={null} paymentResponseHeader={null} />
    </main>
  );
}
