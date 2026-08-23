"use client";

/**
 * Animates created -> pending -> approved/declined/expired -> settled/failed
 * as SSE events arrive, keyed off each event's `state` and `previousState`
 * (CLAUDE.md's "State machine" / "Pub/sub event schema" sections).
 *
 * In practice `created` and `expired` are rarely-if-ever seen live: per
 * packages/scheme-upi/src/state-machine.ts, `createTrackedRequest` does not
 * publish an event ("created" has no previousState to report), and a
 * timeout resolves `awaitResolution` locally without ever publishing an
 * "expired" event. Both stay in the diagram as defined states regardless --
 * this component visualizes the schema, not just whatever a single demo run
 * happens to produce.
 *
 * Unrecognized `state` strings (schema drift) are console.warn'd and
 * otherwise ignored: the previously-visualized state is left unchanged, no
 * reset, no throw, no error boundary.
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { EmptyState } from "./EmptyState";
import { cn } from "../lib/utils";
import { isKnownState, type FiatEvent, type RequestState } from "../lib/events";

export interface StateMachineVizProps {
  event: FiatEvent | null;
}

interface Stage {
  label: string;
  states: { state: RequestState; label: string }[];
}

const STAGES: Stage[] = [
  { label: "Created", states: [{ state: "created", label: "created" }] },
  { label: "Payment Link", states: [{ state: "pending", label: "pending" }] },
  {
    label: "Payer outcome",
    states: [
      { state: "approved", label: "approved" },
      { state: "declined", label: "declined" },
      { state: "expired", label: "expired" },
    ],
  },
  {
    label: "Terminal",
    states: [
      { state: "settled", label: "settled" },
      { state: "failed", label: "failed" },
    ],
  },
];

function boxTone(status: "current" | "visited" | "idle") {
  if (status === "current") return "border-primary bg-primary/15 text-primary scale-105 shadow-[0_0_0_3px] shadow-primary/20";
  if (status === "visited") return "border-success/50 bg-success/10 text-success";
  return "border-border bg-muted text-muted-foreground";
}

interface Trail {
  requestId: string;
  history: RequestState[];
}

export function StateMachineViz({ event }: StateMachineVizProps) {
  const [trail, setTrail] = useState<Trail | null>(null);

  useEffect(() => {
    if (!event) return;

    if (!isKnownState(event.state)) {
      // Schema drift: never seen before. Leave the visualization exactly as
      // it was -- do not reset, do not throw.
      console.warn(`StateMachineViz: unrecognized state "${event.state}" for request ${event.requestId}; ignoring`);
      return;
    }

    setTrail(prev => {
      if (!prev || prev.requestId !== event.requestId) {
        // No trail yet, or a different requestId: a new flow started, begin a fresh trail.
        return { requestId: event.requestId, history: [event.state] };
      }
      if (prev.history[prev.history.length - 1] === event.state) return prev;
      return { requestId: prev.requestId, history: [...prev.history, event.state] };
    });
  }, [event]);

  const requestId = trail?.requestId ?? null;
  const history = trail?.history ?? [];
  const current = history[history.length - 1] ?? null;
  const visited = new Set(history);

  if (!requestId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>State machine</CardTitle>
          <CardDescription>created &rarr; pending &rarr; approved|declined|expired &rarr; settled|failed</CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState>No requests yet. The diagram animates as soon as one enters &quot;pending&quot;.</EmptyState>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>State machine</CardTitle>
        <CardDescription>Request: {requestId}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
          {STAGES.map((stage, stageIndex) => (
            <div key={stage.label} className="flex items-center gap-2">
              <div className="flex flex-col gap-1.5">
                <div className="text-center text-[10px] uppercase tracking-wide text-muted-foreground">{stage.label}</div>
                <div className="flex flex-col gap-1.5">
                  {stage.states.map(({ state, label }) => {
                    const status = state === current ? "current" : visited.has(state) ? "visited" : "idle";
                    return (
                      <div
                        key={state}
                        className={cn(
                          "rounded-lg border px-3 py-1.5 text-center text-xs font-medium transition-all duration-300 ease-out",
                          boxTone(status),
                        )}
                      >
                        {label}
                      </div>
                    );
                  })}
                </div>
              </div>
              {stageIndex < STAGES.length - 1 && <div className="self-center text-muted-foreground">&rarr;</div>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
