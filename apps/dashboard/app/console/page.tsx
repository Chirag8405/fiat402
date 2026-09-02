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

import { useEffect, useRef, useState } from "react";
import { ConnectionIndicator, type ConnectionStatus } from "../../components/ConnectionIndicator";
import { AgentConsole, type CapturedHeaders } from "../../components/AgentConsole";
import { RawTrafficViewer } from "../../components/RawTrafficViewer";
import { UpiCollectCard } from "../../components/UpiCollectCard";
import { StateMachineViz } from "../../components/StateMachineViz";
import { DecisionPanel, type DeterministicDecision, type AiAdvisory } from "../../components/DecisionPanel";
import { ReconciliationRecord, type ObservedTimestamps, type ReconciliationExtras } from "../../components/ReconciliationRecord";
import { isFiatEventShape, isKnownState, type FiatEvent } from "../../lib/events";
import { reconstructTrail, trailsEqual, type RequestTrail } from "../../lib/trail";
import type { ReconciliationRecordDto } from "../../lib/types";

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
 * sessionStorage persistence for `simulateHeaders` (PAYMENT-REQUIRED/
 * PAYMENT-SIGNATURE captured during a live Simulate Agent run) -- session-
 * scoped is correct here (no need to survive a closed tab), unlike
 * trail/decision/reconciliation, which re-derive from Redis/Postgres on
 * load rather than needing browser storage at all.
 *
 * The real `requestId` a captured run will produce isn't known at capture
 * time (see components/AgentConsole.tsx's top comment / app/api/simulate/
 * route.ts -- the facilitator mixes in a random UUID we never see), so this
 * is a two-step write: onHeadersCaptured writes to a single fixed PENDING_KEY
 * immediately; once the poll loop discovers the real requestId (or, on a
 * fresh page load, whatever requestId is already current), the effect below
 * promotes that pending entry onto the real per-request key. onRunStart
 * clears the pending slot too, so an abandoned run's capture can't attach
 * itself to some later, unrelated request.
 *
 * Accepted edge case, not engineered around per "keep this simple": if an
 * unrelated request's requestId happens to surface before the current run's
 * own request does, it would wrongly adopt the pending slot's headers. Same
 * class of limitation this app already accepts elsewhere (only one "current"
 * trail is ever tracked). No timestamp/expiry logic added to guard against
 * it -- sessionStorage's own natural lifecycle (cleared when the tab closes)
 * is the only lifecycle here.
 */
const SIMULATE_HEADERS_PENDING_KEY = "fiat402:simulate-headers:pending";

function simulateHeadersKey(requestId: string): string {
  return `fiat402:simulate-headers:${requestId}`;
}

function readSessionStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Private-mode / quota edge cases -- header display still works from
    // React state this session, it just won't survive a refresh.
  }
}

function removeSessionStorage(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing to clean up if storage isn't reachable in the first place.
  }
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
  // { razorpayPaymentId, header } for the one PAYMENT-RESPONSE fetch attempt
  // per razorpayPaymentId -- `header` is null both while unresolved and if
  // the fetch came back empty (settlement failed, or the value already aged
  // out of Redis); either way, no further attempts are made for the same id.
  const [simulatePaymentResponse, setSimulatePaymentResponse] = useState<{ razorpayPaymentId: string; header: string | null } | null>(null);
  // Guards the fetch-once effect below against StrictMode's double-invoke
  // and re-renders that don't change razorpayPaymentId -- state alone isn't
  // enough since the effect's own setSimulatePaymentResponse call is what
  // would otherwise need to be in its own dependency array.
  const attemptedPaymentResponseFor = useRef<string | null>(null);

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

  // Promotes a pending simulate capture onto the real requestId once it's
  // known, or hydrates from an already-promoted entry -- see
  // SIMULATE_HEADERS_PENDING_KEY's doc comment above for the full design.
  // Firing on every `requestId` change (including the first time it becomes
  // non-null after a fresh page load) is what makes "hydrate on load if a
  // match exists" and "promote once discovered during a live session" the
  // same code path. When neither a keyed nor a pending entry exists, this
  // explicitly clears `simulateHeaders` -- without that, a new unrelated
  // request (a real payment) would keep showing a previous simulate run's
  // stale headers indefinitely, since nothing else clears them except a new
  // Run click.
  useEffect(() => {
    if (!requestId) {
      setSimulateHeaders(null);
      return;
    }
    const key = simulateHeadersKey(requestId);
    let stored = readSessionStorage(key);
    if (!stored) {
      const pending = readSessionStorage(SIMULATE_HEADERS_PENDING_KEY);
      if (pending) {
        writeSessionStorage(key, pending);
        removeSessionStorage(SIMULATE_HEADERS_PENDING_KEY);
        stored = pending;
      }
    }
    if (!stored) {
      setSimulateHeaders(null);
      return;
    }
    try {
      setSimulateHeaders(JSON.parse(stored) as CapturedHeaders);
    } catch {
      setSimulateHeaders(null);
    }
  }, [requestId]);
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

  // Fetches the PAYMENT-RESPONSE header app/api/simulate/route.ts's
  // deferred `after()` call persisted to Redis (see
  // lib/simulate-payment-response.ts) -- exactly once per razorpayPaymentId,
  // triggered by reaching a terminal state, never polled: there's nothing to
  // poll for, this either resolves once or never will (a failed settlement
  // never had a PAYMENT-RESPONSE to capture in the first place, so this
  // deliberately never even fires when liveRazorpayPaymentId is null).
  useEffect(() => {
    if (finalOutcome === null || !liveRazorpayPaymentId) return;
    if (attemptedPaymentResponseFor.current === liveRazorpayPaymentId) return;
    attemptedPaymentResponseFor.current = liveRazorpayPaymentId;

    let cancelled = false;
    const currentRazorpayPaymentId = liveRazorpayPaymentId;

    (async () => {
      let header: string | null = null;
      try {
        const res = await fetch(`/api/simulate/payment-response/${encodeURIComponent(currentRazorpayPaymentId)}`);
        if (res.ok) {
          const body = (await res.json()) as { paymentResponseHeader: string | null };
          header = body.paymentResponseHeader;
        }
      } catch (err) {
        console.warn(`page: /api/simulate/payment-response/${currentRazorpayPaymentId} request failed`, err);
      }
      if (!cancelled) setSimulatePaymentResponse({ razorpayPaymentId: currentRazorpayPaymentId, header });
    })();

    return () => {
      cancelled = true;
    };
  }, [finalOutcome, liveRazorpayPaymentId]);

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
  // Guarded on razorpayPaymentId matching, not just `showLive`: protects
  // against a brief transitional render showing a previous request's
  // already-fetched header before the effect above re-fires for a new one.
  const displayPaymentResponseHeader =
    showLive && simulatePaymentResponse?.razorpayPaymentId === liveRazorpayPaymentId ? simulatePaymentResponse.header : null;
  // Still genuinely in flight (no terminal state yet) with request/signature
  // already captured -- once finalOutcome is reached this becomes false,
  // whether or not a PAYMENT-RESPONSE was ever retrieved, so
  // RawTrafficViewer stops showing "pending" once settlement is genuinely
  // over rather than forever.
  const displayPaymentResponsePending = showLive && finalOutcome === null && Boolean(displaySimulateHeaders);

  // Reset/Show-last are gated on `trail` (the real data), not `displayMode`
  // -- "is there anything to act on" is a question about the underlying
  // data, independent of what's currently being shown.
  const canReset = trail !== null && displayMode === "live";
  const canShowLast = trail !== null && displayMode === "reset";

  return (
    <main className="console-page mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6">
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

      <AgentConsole
        onRunStart={() => {
          setSimulateHeaders(null);
          removeSessionStorage(SIMULATE_HEADERS_PENDING_KEY);
        }}
        onHeadersCaptured={headers => {
          setSimulateHeaders(headers);
          writeSessionStorage(SIMULATE_HEADERS_PENDING_KEY, JSON.stringify(headers));
        }}
      />

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
        paymentResponseHeader={displayPaymentResponseHeader}
        paymentResponsePending={displayPaymentResponsePending}
      />
    </main>
  );
}
