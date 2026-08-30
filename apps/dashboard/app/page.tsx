"use client";

/**
 * Composes the five panels over a poll loop against /api/events (see that
 * route's top-of-file comment) -- replaces the former EventSource connection
 * to /api/stream (deleted; a held-open SSE connection didn't fit Vercel's
 * serverless model reliably). Polling lifecycle:
 *   - Every POLL_INTERVAL_MS, fetch /api/events (no cursor -- see that
 *     route's top comment on why the earlier cursor-based version was
 *     unsafe: it could permanently exclude an event that raced behind a
 *     later-timestamped sibling's LPUSH). Each poll returns the FULL current
 *     bounded list, sorted by timestamp.
 *   - Each raw event: parse JSON, validate the FiatEvent shape, validate
 *     `state` is known before deriving anything from it; an unknown state is
 *     console.warn'd and otherwise dropped here (each panel that touches
 *     `state` -- StateMachineViz in particular -- has its own
 *     belt-and-suspenders guard too).
 *   - `reconstructTrail` then rebuilds `trail` from scratch every poll
 *     (picks the most recently active requestId, dedupes its events by
 *     `state`) rather than accumulating incrementally -- a given
 *     (requestId, state) pair is idempotent to see more than once, so
 *     reprocessing the whole list every time is safe and simple at this
 *     app's demo scale. `trailsEqual` then keeps `trail`'s reference stable
 *     across polls that carry no new data for the current request --
 *     load-bearing, not just tidy: the Reset/Show-last feature below and the
 *     Postgres-fallback effect both depend on `trail` NOT changing identity
 *     when nothing actually changed.
 *   - A successful poll -> "polling" status with a lastPolledAt timestamp,
 *     visible on ConnectionIndicator.
 *   - A failed poll (network error or non-OK response) -> "connection-issue"
 *     status; the loop keeps retrying on the same interval regardless.
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
import { AgentConsole, type CapturedHeaders } from "../components/AgentConsole";
import { RawTrafficViewer } from "../components/RawTrafficViewer";
import { UpiCollectCard } from "../components/UpiCollectCard";
import { StateMachineViz } from "../components/StateMachineViz";
import { DecisionPanel, type DeterministicDecision, type AiAdvisory } from "../components/DecisionPanel";
import { ReconciliationRecord, type ObservedTimestamps, type ReconciliationExtras } from "../components/ReconciliationRecord";
import { isFiatEventShape, isKnownState, type FiatEvent } from "../lib/events";
import { reconstructTrail, trailsEqual, type RequestTrail } from "../lib/trail";
import type { ReconciliationRecordDto } from "../lib/types";

const POLL_INTERVAL_MS = 2500;

interface EventsResponse {
  events: unknown[];
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
  razorpayPaymentId: string | null;
}

/**
 * "live" shows whatever `trail` currently holds (the normal, default mode);
 * "reset" is a purely local display-suppression mode -- the Reset button
 * flips into it, "Show last" flips back out. Neither state ever touches
 * `trail`/`postgresFallback` (the actual accumulated data) or any network
 * call: this only gates what gets passed to the panels at render time, at
 * the very bottom of this component, so "Show last" has nothing to
 * re-fetch -- the data it restores was never discarded, only hidden.
 */
type DisplayMode = "live" | "reset";

export default function DashboardPage() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [trail, setTrail] = useState<RequestTrail | null>(null);
  const [postgresFallback, setPostgresFallback] = useState<PostgresFallback | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("live");
  // Scoped to the current AgentConsole simulate run, not to `trail` -- reset
  // via AgentConsole's onRunStart at the exact same moment its own `lines`
  // reset, per that component's own doc comment. Deliberately NOT cleared by
  // unrelated trail changes (a real external payment arriving while these
  // are still showing), matching AgentConsole's own accepted lifecycle.
  const [simulateHeaders, setSimulateHeaders] = useState<CapturedHeaders | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const response = await fetch("/api/events");
        if (!response.ok) throw new Error(`poll failed with status ${response.status}`);

        const data = (await response.json()) as EventsResponse;
        if (cancelled) return;

        setStatus("polling");
        setLastPolledAt(new Date().toISOString());

        const validEvents: FiatEvent[] = [];
        for (const raw of data.events) {
          if (!isFiatEventShape(raw)) continue;
          if (!isKnownState(raw.state)) {
            console.warn(`page: received unrecognized state "${raw.state}" for request ${raw.requestId}; ignoring`);
            continue;
          }
          validEvents.push(raw);
        }

        const next = reconstructTrail(validEvents);
        setTrail(prev => (trailsEqual(prev, next) ? prev : next));
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

  // A genuinely new event (new request, or -- structurally impossible today,
  // but harmless either way -- more events on the same one) always takes
  // over the display, overriding whatever Reset/Show-last state the user is
  // in: `trail`'s reference only changes inside applyEvent's setTrail calls
  // above, so this effect simply doesn't refire between polls that carry
  // nothing new, which is what lets a manual Reset/Show-last click stick
  // undisturbed until real new data actually arrives.
  useEffect(() => {
    setDisplayMode("live");
  }, [trail]);

  const events = trail?.events ?? [];
  const requestId = trail?.requestId ?? null;
  const current = events[events.length - 1] ?? null;
  const paymentLinkId = [...events].reverse().find(event => event.meta.paymentLinkId)?.meta.paymentLinkId ?? null;
  const liveRazorpayPaymentId = [...events].reverse().find(event => event.meta.razorpayPaymentId)?.meta.razorpayPaymentId ?? null;
  const finalOutcome = current?.state === "settled" || current?.state === "failed" ? current.state : null;
  // Only derivable from the live trail -- see ReconciliationRecord.tsx's
  // `failureReason` doc comment for why the Postgres fallback can't supply
  // this (no reason column on that table).
  const failureReason = current?.state === "failed" ? (current.meta.reason ?? null) : null;
  const liveDecision = deriveDecision(events);
  const hasLiveDecision = liveDecision.deterministic !== null || liveDecision.ai !== null;
  // txnRef/amountPaise/payTo have NO live source at all -- no FiatEvent
  // field ever carries them (see ReconciliationRecord.tsx's top-of-file
  // comment) -- so this is effectively always true once a request is
  // terminal, regardless of whether decision data happens to be present.
  // razorpayPaymentId CAN be live (the settled/approved event's own
  // meta.razorpayPaymentId), so it's checked for real rather than assumed
  // missing. Deliberately independent of `hasLiveDecision`: that gate was
  // previously reused for this fetch too, which meant the extras backfill
  // only ever fired on the rare request with NO live decision data --
  // in practice essentially never, so txnRef/amountPaise/payTo/
  // razorpayPaymentId almost always showed "not available" even though the
  // reconciliation row existed in Postgres the whole time.
  const missingExtras = liveRazorpayPaymentId === null;

  // Falls back to Postgres (via the facilitator's GET /reconciliation/:requestId,
  // proxied at /api/reconciliation/:requestId) once a request has reached a
  // terminal outcome AND either the live event stream has no decision-layer
  // data for it, or the extras fields above are missing live -- these are two
  // independent reasons to fetch the same record, not one combined gate:
  // live decision data is still preferred/used as-is whenever it exists (see
  // the merge below), this fetch just also needs to run for the extras' own
  // sake even when decision data is fine. Closes the gap where the "pending"
  // event carrying aiRecommendation/aiSemanticMatch/etc. has scrolled out of
  // fiat402:events:recent's bounded 200-entry window (or the tab was
  // reopened after it already had), even though a full reconciliation record
  // was durably written to Postgres once the request settled/failed -- see
  // ReconciliationRecord.tsx's top-of-file comment.
  const needsPostgresFallback = Boolean(requestId) && finalOutcome !== null && (!hasLiveDecision || missingExtras);

  useEffect(() => {
    if (!requestId || !finalOutcome || !needsPostgresFallback) {
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
                razorpayPaymentId: record.razorpayPaymentId,
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
  }, [requestId, finalOutcome, needsPostgresFallback]);

  const { deterministic, ai } = hasLiveDecision ? liveDecision : (postgresFallback?.decision ?? liveDecision);
  const reconciliationExtras = postgresFallback?.extras ?? emptyReconciliationExtras();
  const razorpayPaymentId = liveRazorpayPaymentId ?? postgresFallback?.razorpayPaymentId ?? null;

  // Render-boundary suppression only -- everything above (trail,
  // postgresFallback, and everything derived from them) is untouched by
  // displayMode. "reset" just means these panels get idle/empty props for
  // this render; StateMachineViz gets the real `events` regardless (plus
  // forceIdle) so its own internal queue keeps accumulating underneath, per
  // that component's own doc comment on why.
  const showLive = displayMode === "live";
  const displayRequestId = showLive ? requestId : null;
  const displayState = showLive ? (current?.state ?? null) : null;
  const displayFinalOutcome = showLive ? finalOutcome : null;
  const displayDeterministic = showLive ? deterministic : null;
  const displayAi = showLive ? ai : null;
  const displayPaymentLinkId = showLive ? paymentLinkId : null;
  const displayRazorpayPaymentId = showLive ? razorpayPaymentId : null;
  const displayExtras = showLive ? reconciliationExtras : emptyReconciliationExtras();
  const displayFailureReason = showLive ? failureReason : null;
  const displayTimestamps = showLive ? deriveTimestamps(events) : emptyTimestamps();
  const displaySimulateHeaders = showLive ? simulateHeaders : null;

  // Reset/Show-last are gated on `trail` (the real data), not `displayMode`
  // -- "is there anything to act on" is a question about the underlying
  // data, independent of what's currently being shown.
  const canReset = trail !== null && displayMode === "live";
  const canShowLast = trail !== null && displayMode === "reset";

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">fiat402 control tower</h1>
          <p className="text-xs text-muted-foreground">Polling view over the fiat402:events Redis channel</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setDisplayMode("reset")}
              disabled={!canReset}
              className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-[opacity,background-color] duration-150 ease-[var(--ease-out)] hover:bg-muted disabled:opacity-40"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => setDisplayMode("live")}
              disabled={!canShowLast}
              className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-[opacity,background-color] duration-150 ease-[var(--ease-out)] hover:bg-muted disabled:opacity-40"
            >
              Show last
            </button>
          </div>
          <ConnectionIndicator status={status} lastPolledAt={lastPolledAt} />
        </div>
      </header>

      <AgentConsole onRunStart={() => setSimulateHeaders(null)} onHeadersCaptured={setSimulateHeaders} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <StateMachineViz events={events} forceIdle={!showLive} />
        <UpiCollectCard requestId={displayRequestId} state={displayState} paymentLinkId={displayPaymentLinkId} />
        <DecisionPanel requestId={displayRequestId} state={displayState} deterministic={displayDeterministic} ai={displayAi} />
        <ReconciliationRecord
          requestId={displayRequestId}
          finalOutcome={displayFinalOutcome}
          razorpayPaymentId={displayRazorpayPaymentId}
          paymentLinkId={displayPaymentLinkId}
          timestamps={displayTimestamps}
          deterministic={displayDeterministic}
          ai={displayAi}
          extras={displayExtras}
          failureReason={displayFailureReason}
        />
      </div>

      <RawTrafficViewer
        requestId={displayRequestId}
        paymentRequiredHeader={displaySimulateHeaders?.paymentRequiredHeader ?? null}
        paymentSignatureHeader={displaySimulateHeaders?.paymentSignatureHeader ?? null}
        paymentResponseHeader={null}
      />
    </main>
  );
}
