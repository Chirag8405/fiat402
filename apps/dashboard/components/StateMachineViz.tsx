"use client";

/**
 * Animates created -> pending -> approved/declined/expired -> settled/failed
 * as polled events arrive (see ../app/page.tsx's poll loop against
 * /api/events), keyed off each event's `state` (CLAUDE.md's "State machine"
 * / "Pub/sub event schema" sections).
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
 *
 * Minimum-visible-duration queue: this component receives the *full* event
 * trail for the currently-tracked request (`events`), not just the latest
 * one -- page.tsx's poll loop can, and does, resolve a payment fast enough
 * that "pending", "approved", and "settled" all land within a single poll
 * batch (or across two polls milliseconds apart). Rendering the latest state
 * immediately would make the UI appear to jump straight from "pending" to
 * "settled", skipping "approved" entirely -- the payer outcome is the whole
 * point of this diagram. So instead of mirroring `events` directly into
 * display state, new distinct states are enqueued and paced out at least
 * MIN_VISIBLE_MS apart, oldest first, regardless of how fast they actually
 * arrived. A terminal state arriving early never jumps the queue -- it just
 * waits its turn, per this file's own point: showing the full journey.
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { EmptyState } from "./EmptyState";
import { cn } from "../lib/utils";
import { isKnownState, type FiatEvent, type RequestState } from "../lib/events";

export interface StateMachineVizProps {
  /** Full event trail for the currently-tracked request, oldest first (see this file's top comment on why "latest only" isn't enough). */
  events: FiatEvent[];
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

type NodeStatus = "current" | "visited" | "idle";

/**
 * Node styling only -- no infinite/looping animation here. The `current`
 * ring-shadow is a static style applied once a node becomes current, not a
 * pulsing keyframe: per this file's design brief, the rail lights up on real
 * transitions only, never via decorative looping motion. Transform + color
 * transition at 180ms with the shared --ease-out curve is the only motion.
 */
function nodeTone(status: NodeStatus) {
  if (status === "current") return "border-primary bg-primary/15 text-primary scale-[1.08] shadow-[0_0_0_3px] shadow-primary/20";
  if (status === "visited") return "border-success/50 bg-success/10 text-success";
  return "border-border bg-muted text-muted-foreground";
}

/** Whether the connecting track segment leading INTO `stage` should be lit -- true once any state in that stage has actually been reached. */
function stageReached(stage: Stage, current: RequestState | null, visited: Set<RequestState>): boolean {
  return stage.states.some(({ state }) => state === current || visited.has(state));
}

/** Minimum time (ms) each state is shown before the queue advances to the next one. */
const MIN_VISIBLE_MS = 800;

export interface QueueState {
  requestId: string;
  /** States actually rendered so far, oldest first. */
  displayed: RequestState[];
  /** States waiting their turn, oldest first. */
  pending: RequestState[];
}

/**
 * Reduces a request's full event trail to the distinct sequence of states it
 * passed through (consecutive duplicates collapsed to one), skipping and
 * warning on any unrecognized state -- same belt-and-suspenders guard the
 * old single-event version had, kept even though ../app/page.tsx's poll
 * loop already filters these before they ever reach this component.
 *
 * Exported (with the two functions below) so the queueing algorithm itself
 * -- the actual fix -- is unit-testable without a component-rendering
 * harness, which this package doesn't otherwise have; see test/state-machine-viz.test.ts.
 */
export function distinctStateSequence(events: FiatEvent[], requestId: string): RequestState[] {
  const sequence: RequestState[] = [];
  for (const event of events) {
    if (!isKnownState(event.state)) {
      console.warn(`StateMachineViz: unrecognized state "${event.state}" for request ${requestId}; ignoring`);
      continue;
    }
    if (sequence[sequence.length - 1] !== event.state) sequence.push(event.state);
  }
  return sequence;
}

/**
 * Folds a request's full event trail into the next queue state: starts a
 * fresh queue (first state shown immediately, rest queued) when `events`
 * belongs to a different request than `prev`, or appends whatever's new
 * beyond what's already displayed/queued for the same request. Never
 * removes, reorders, or jumps ahead -- a terminal state arriving early just
 * takes its place at the back of `pending` like everything else.
 */
export function enqueueNewStates(prev: QueueState | null, events: FiatEvent[]): QueueState | null {
  if (events.length === 0) return prev;

  const requestId = events[0]!.requestId;
  const targetSequence = distinctStateSequence(events, requestId);
  if (targetSequence.length === 0) return prev;

  if (!prev || prev.requestId !== requestId) {
    const [first, ...rest] = targetSequence;
    return { requestId, displayed: [first!], pending: rest };
  }

  const alreadyKnown = prev.displayed.length + prev.pending.length;
  const newTail = targetSequence.slice(alreadyKnown);
  if (newTail.length === 0) return prev;
  return { requestId: prev.requestId, displayed: prev.displayed, pending: [...prev.pending, ...newTail] };
}

/** Pops one state off `pending` onto the end of `displayed`. No-op if `pending` is empty. */
export function advanceQueue(prev: QueueState): QueueState {
  if (prev.pending.length === 0) return prev;
  const [next, ...rest] = prev.pending;
  return { requestId: prev.requestId, displayed: [...prev.displayed, next!], pending: rest };
}

export function StateMachineViz({ events }: StateMachineVizProps) {
  const [queue, setQueue] = useState<QueueState | null>(null);

  // Enqueue newly-seen states whenever a new trail (or a longer version of
  // the current one) arrives. Only ever appends -- never removes or
  // reorders what's already displayed/queued for the same requestId.
  useEffect(() => {
    setQueue(prev => enqueueNewStates(prev, events));
  }, [events]);

  // Pace the queue: advance one state at a time, at least MIN_VISIBLE_MS
  // apart. Re-fires on every queue mutation (including its own advance),
  // which is what makes this a self-driving "tick" rather than a one-shot
  // timer -- the cleanup below guarantees only one timer is ever live.
  useEffect(() => {
    if (!queue || queue.pending.length === 0) return;

    const timer = setTimeout(() => {
      setQueue(prev => (prev ? advanceQueue(prev) : prev));
    }, MIN_VISIBLE_MS);

    return () => clearTimeout(timer);
  }, [queue]);

  const requestId = queue?.requestId ?? null;
  const history = queue?.displayed ?? [];
  const current = history[history.length - 1] ?? null;
  const visited = new Set(history);

  return (
    <Card>
      <CardHeader>
        <CardTitle>State machine</CardTitle>
        <CardDescription>{requestId ? `Request: ${requestId}` : "created → pending → approved|declined|expired → settled|failed"}</CardDescription>
      </CardHeader>
      <CardContent>
        {!requestId && (
          <div className="mb-3">
            <EmptyState>No requests yet. The rail lights up as soon as one enters &quot;pending&quot;.</EmptyState>
          </div>
        )}
        <Rail stages={STAGES} current={current} visited={visited} />
      </CardContent>
    </Card>
  );
}

/**
 * The rail itself: a row of stage nodes connected by track segments that
 * fill in as real transitions arrive. Rendered even at idle (all nodes
 * `idle`, all segments unlit) so the first real event reads as the rail
 * lighting up rather than a card materializing from nothing.
 */
function Rail({ stages, current, visited }: { stages: Stage[]; current: RequestState | null; visited: Set<RequestState> }) {
  return (
    <div className="flex items-start gap-0 overflow-x-auto pb-1">
      {stages.map((stage, stageIndex) => (
        <div key={stage.label} className="flex items-start">
          <div className="flex min-w-[92px] flex-col items-center gap-2">
            <div className="text-center text-[10px] uppercase tracking-wide text-muted-foreground">{stage.label}</div>
            <div className="flex flex-col items-center gap-1.5">
              {stage.states.map(({ state, label }) => {
                const status: NodeStatus = state === current ? "current" : visited.has(state) ? "visited" : "idle";
                return (
                  <div
                    key={state}
                    className={cn(
                      "rounded-full border px-3 py-1 text-center text-xs font-medium",
                      "transition-[transform,background-color,color,border-color,box-shadow] duration-[180ms] ease-[var(--ease-out)]",
                      nodeTone(status),
                    )}
                  >
                    {label}
                  </div>
                );
              })}
            </div>
          </div>
          {stageIndex < stages.length - 1 && (
            <div className="relative mt-4 h-0.5 w-10 shrink-0 overflow-hidden rounded-full bg-border">
              <div
                className={cn(
                  "absolute inset-0 origin-left rounded-full bg-success",
                  "transition-transform duration-200 ease-[var(--ease-out)]",
                  stageReached(stages[stageIndex + 1]!, current, visited) ? "scale-x-100" : "scale-x-0",
                )}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
