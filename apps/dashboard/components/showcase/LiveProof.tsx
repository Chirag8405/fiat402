"use client";

/**
 * Section 5 -- "live proof". Embeds the real StateMachineViz/DecisionPanel/
 * AgentConsole/RawTrafficViewer components, driven ONLY by the three
 * captured fixtures in fixtures/*.json via lib/replay-fixtures.ts's
 * ReplaySource -- never /api/simulate, /api/confirm-gate, or /api/decline.
 *
 * AgentConsole is given `replaySource` (see components/AgentConsole.tsx's
 * top comment), so its buttons/persona list and its own console-line
 * playback come entirely from the fixtures, on the timer
 * lib/replay-fixtures.ts's buildReplaySteps encodes (paced to feel like the
 * real route's stagger, not instant).
 *
 * Once AgentConsole's synthetic run completes (onRunComplete), the fixture's
 * full events[] is handed to StateMachineViz in one shot -- that component
 * already paces itself through the distinct states it finds (its own
 * MIN_VISIBLE_MS queue, unmodified, per its own top comment), so nothing
 * extra is needed there. DecisionPanel is separately paced by this
 * component (advancing one distinct state at a time, same idea, so its
 * pending/Confirm-Decline framing briefly shows before resolving, echoing
 * the rail) and rendered with `interactive={false}` -- the buttons are
 * visible (so a replay of an AI-hold run reads the same as a live one) but
 * inert, per components/DecisionPanel.tsx's own doc comment.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { StateMachineViz, distinctStateSequence } from "../StateMachineViz";
import { DecisionPanel, type DeterministicDecision, type AiAdvisory } from "../DecisionPanel";
import { AgentConsole, type CapturedHeaders } from "../AgentConsole";
import { RawTrafficViewer } from "../RawTrafficViewer";
import type { FiatEvent, RequestState } from "../../lib/events";
import { buildReplaySource, getFixture, deriveDecisionFromFixture, type FixtureKey } from "../../lib/replay-fixtures";

const STATE_STEP_MS = 800;
const TERMINAL_STATES: ReadonlySet<RequestState> = new Set(["settled", "failed"]);

interface HeadersDisplay {
  paymentRequiredHeader: string | null;
  paymentSignatureHeader: string | null;
  paymentResponseHeader: string | null;
}

const EMPTY_HEADERS: HeadersDisplay = { paymentRequiredHeader: null, paymentSignatureHeader: null, paymentResponseHeader: null };
const EMPTY_DECISION: { deterministic: DeterministicDecision | null; ai: AiAdvisory | null } = { deterministic: null, ai: null };

export function LiveProof() {
  const replaySource = useMemo(() => buildReplaySource(), []);
  const activeFixtureKeyRef = useRef<FixtureKey | null>(null);

  const [requestId, setRequestId] = useState<string | null>(null);
  const [events, setEvents] = useState<FiatEvent[]>([]);
  const [decision, setDecision] = useState(EMPTY_DECISION);
  const [headers, setHeaders] = useState<HeadersDisplay>(EMPTY_HEADERS);
  const [stateStepIndex, setStateStepIndex] = useState(0);

  function handleRunStart(personaKey: string): void {
    activeFixtureKeyRef.current = personaKey as FixtureKey;
    setRequestId(null);
    setEvents([]);
    setDecision(EMPTY_DECISION);
    setHeaders(EMPTY_HEADERS);
    setStateStepIndex(0);
  }

  function handleHeadersCaptured(captured: CapturedHeaders): void {
    setHeaders(prev => ({ ...prev, paymentRequiredHeader: captured.paymentRequiredHeader, paymentSignatureHeader: captured.paymentSignatureHeader }));
  }

  function handleRunComplete(status: "done" | "error"): void {
    const key = activeFixtureKeyRef.current;
    if (status !== "done" || !key) return;
    const fixture = getFixture(key);
    setRequestId(fixture.requestId);
    setEvents(fixture.events);
    setDecision(deriveDecisionFromFixture(fixture.events));
    setHeaders(prev => ({ ...prev, paymentResponseHeader: fixture.headers.paymentResponseHeader }));
  }

  // Paces DecisionPanel/RawTrafficViewer's displayed `state` one distinct
  // state at a time -- independent of StateMachineViz's own internal queue,
  // but the same idea (MIN_VISIBLE_MS-style stepping), so the panels read as
  // part of one unfolding story rather than a rail animating next to two
  // panels that already jumped straight to the end.
  const sequence = requestId ? distinctStateSequence(events, requestId) : [];
  useEffect(() => {
    if (stateStepIndex >= sequence.length - 1) return;
    const timer = setTimeout(() => setStateStepIndex(index => index + 1), STATE_STEP_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateStepIndex, sequence.length]);

  const displayState: RequestState | null = sequence[stateStepIndex] ?? null;
  const isTerminal = displayState !== null && TERMINAL_STATES.has(displayState);
  const paymentResponsePending = Boolean(requestId) && !isTerminal && Boolean(headers.paymentRequiredHeader);

  return (
    <section className="relative min-h-screen bg-background px-6 py-24">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">live proof</p>
            <h2 className="mt-1 text-2xl font-semibold text-foreground sm:text-3xl">The real control tower, replayed</h2>
          </div>
          <span className="rounded-full border border-border px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            recorded demo
          </span>
        </div>

        <AgentConsole
          replaySource={replaySource}
          onRunStart={handleRunStart}
          onHeadersCaptured={handleHeadersCaptured}
          onRunComplete={handleRunComplete}
        />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <StateMachineViz events={events} />
          <DecisionPanel requestId={requestId} state={displayState} deterministic={decision.deterministic} ai={decision.ai} interactive={false} />
        </div>

        <RawTrafficViewer
          requestId={requestId}
          paymentRequiredHeader={headers.paymentRequiredHeader}
          paymentSignatureHeader={headers.paymentSignatureHeader}
          paymentResponseHeader={headers.paymentResponseHeader}
          paymentResponsePending={paymentResponsePending}
        />
      </div>
    </section>
  );
}
