"use client";

/**
 * Terminal-style panel that triggers a real agent payment request via
 * POST /api/simulate (see that route's top-of-file comment for the full
 * fire-and-forget design) and streams back the genuinely fast, real
 * pre-payment steps as NDJSON lines -- each line corresponds to an actual
 * await completing server-side (probe fetch, 402 received, payload
 * constructed), not a fixed animation schedule.
 *
 * Deliberately stops there: once the route hands the request off to the
 * facilitator, the stream closes and this component goes quiet -- the
 * existing StateMachineViz/DecisionPanel already correctly represent
 * verify/advisory/settle via the normal poll loop against /api/events, and
 * duplicating that state here would mean two sources of truth for the same
 * request.
 *
 * The stream also carries one structurally distinct message (`{kind:
 * "headers", ...}`, no `line` field) right before the handoff line, carrying
 * the real captured PAYMENT-REQUIRED/PAYMENT-SIGNATURE headers for this run
 * -- see app/api/simulate/route.ts's top-of-file comment for exactly how
 * those are captured/constructed and why that's scoped to simulate-triggered
 * runs only. Lifted out to the parent via `onHeadersCaptured` rather than
 * displayed as console text; `onRunStart` fires at the same moment this
 * component resets its own `lines`, so the parent can reset its held headers
 * on the same lifecycle instead of a separate/drifting one.
 */

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { cn } from "../lib/utils";

type LineKind = "info" | "success" | "error";

export interface ConsoleLine {
  line: string;
  kind: LineKind;
}

export interface CapturedHeaders {
  paymentRequiredHeader: string;
  paymentSignatureHeader: string;
}

interface HeadersMessage extends CapturedHeaders {
  kind: "headers";
}

type RunStatus = "idle" | "running" | "done" | "error";

const PERSONAS = [
  { key: "researchbot", label: "Run ResearchBot", name: "ResearchBot" },
  { key: "travelbot", label: "Run TravelBot", name: "TravelBot" },
] as const;

function isConsoleLine(value: unknown): value is ConsoleLine {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ConsoleLine).line === "string" &&
    typeof (value as ConsoleLine).kind === "string"
  );
}

function isHeadersMessage(value: unknown): value is HeadersMessage {
  return (
    !!value &&
    typeof value === "object" &&
    (value as HeadersMessage).kind === "headers" &&
    typeof (value as HeadersMessage).paymentRequiredHeader === "string" &&
    typeof (value as HeadersMessage).paymentSignatureHeader === "string"
  );
}

function lineTone(kind: LineKind): string {
  if (kind === "error") return "text-danger";
  if (kind === "success") return "text-success";
  return "text-muted-foreground";
}

/**
 * One step of a fixture replay: a console line to append, paced by `delayMs`
 * before it appears (relative to the previous step, not absolute) -- lets a
 * replay source reproduce the real route's stagger (probe -> 402 ->
 * constructing payload -> headers captured -> handed off) without a real
 * network round trip driving the timing.
 */
export interface ReplayStep {
  delayMs: number;
  line: ConsoleLine;
}

export interface ReplaySource {
  personas: { key: string; label: string }[];
  /** Returns the ordered console lines (with pacing) and the headers to hand to onHeadersCaptured, for the given persona key -- or null if this source has nothing for that persona. */
  run(personaKey: string): { steps: ReplayStep[]; headers: CapturedHeaders | null } | null;
}

export interface AgentConsoleProps {
  /** Fires at the same moment this component resets its own `lines` -- see this file's top comment. `personaKey` is the button that was clicked (additive param -- existing zero-arg call sites are unaffected). */
  onRunStart?: (personaKey: string) => void;
  /** Fires when the stream's `{kind: "headers", ...}` message is parsed (or, in replay mode, when the replay source's headers step is reached). */
  onHeadersCaptured?: (headers: CapturedHeaders) => void;
  /** Fires once a run finishes, live or replay, regardless of whether headers were ever captured -- the one reliable "this run is over" signal for a caller that needs to reveal something once the whole thing has played out. */
  onRunComplete?: (status: "done" | "error") => void;
  /**
   * When provided, buttons/personas and the run implementation come from
   * this instead of a real POST to /api/simulate -- no network call is ever
   * made. Default (unset) preserves today's exact live /console behavior.
   * Added for app/page.tsx's fixture-replay showcase, which must never call
   * /api/simulate -- see that file's top comment.
   */
  replaySource?: ReplaySource;
  /**
   * When set, `run(autoRun)` fires once automatically on mount (guarded so
   * it never re-fires on a re-render or a prop-identity change) -- lets a
   * caller auto-play a run rather than waiting for a button click. Default
   * (unset) preserves today's exact live /console behavior, where nothing
   * runs until a button is clicked.
   */
  autoRun?: string;
}

export function AgentConsole({ onRunStart, onHeadersCaptured, onRunComplete, replaySource, autoRun }: AgentConsoleProps) {
  const [activePersona, setActivePersona] = useState<string | null>(null);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  // Guards against a stale stream (from a previous run) still writing lines
  // after a newer run has started -- only the latest run's reader is allowed
  // to touch state.
  const runIdRef = useRef(0);
  const hasAutoRunRef = useRef(false);

  async function runReplay(personaKey: string, source: ReplaySource): Promise<void> {
    const runId = ++runIdRef.current;
    onRunStart?.(personaKey);
    setActivePersona(personaKey);
    setLines([]);
    setStatus("running");

    const result = source.run(personaKey);
    if (!result) {
      setLines([{ line: `no replay fixture available for persona "${personaKey}"`, kind: "error" }]);
      setStatus("error");
      onRunComplete?.("error");
      return;
    }

    let sawError = false;
    for (const step of result.steps) {
      if (step.delayMs > 0) await new Promise(resolve => setTimeout(resolve, step.delayMs));
      if (runIdRef.current !== runId) return;
      if (step.line.kind === "error") sawError = true;
      setLines(prev => [...prev, step.line]);
    }
    if (runIdRef.current !== runId) return;
    if (result.headers) onHeadersCaptured?.(result.headers);
    setStatus(sawError ? "error" : "done");
    onRunComplete?.(sawError ? "error" : "done");
  }

  async function runLive(personaKey: string): Promise<void> {
    const runId = ++runIdRef.current;
    onRunStart?.(personaKey);
    setActivePersona(personaKey);
    setLines([]);
    setStatus("running");

    try {
      const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona: personaKey }),
      });
      if (runIdRef.current !== runId) return;

      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setLines([{ line: body?.error ?? `request failed with status ${res.status}`, kind: "error" }]);
        setStatus("error");
        onRunComplete?.("error");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawError = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (runIdRef.current !== runId) return;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(part);
          } catch {
            continue;
          }
          if (isHeadersMessage(parsed)) {
            onHeadersCaptured?.({ paymentRequiredHeader: parsed.paymentRequiredHeader, paymentSignatureHeader: parsed.paymentSignatureHeader });
            continue;
          }
          if (!isConsoleLine(parsed)) continue;
          if (parsed.kind === "error") sawError = true;
          setLines(prev => [...prev, parsed]);
        }
      }

      if (runIdRef.current === runId) {
        setStatus(sawError ? "error" : "done");
        onRunComplete?.(sawError ? "error" : "done");
      }
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setLines(prev => [...prev, { line: err instanceof Error ? err.message : String(err), kind: "error" }]);
      setStatus("error");
      onRunComplete?.("error");
    }
  }

  function run(personaKey: string): Promise<void> {
    return replaySource ? runReplay(personaKey, replaySource) : runLive(personaKey);
  }

  useEffect(() => {
    if (!autoRun || hasAutoRunRef.current) return;
    hasAutoRunRef.current = true;
    void run(autoRun);
    // run/runReplay/runLive close over replaySource/callbacks by reference
    // each render; only autoRun's PRESENCE (not identity/callback churn)
    // should ever trigger this, per the ref guard above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  const personas = replaySource ? replaySource.personas : PERSONAS;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent console</CardTitle>
        <CardDescription>
          {replaySource
            ? "Replays a captured run -- no live request is sent from this page."
            : "Trigger a real agent request -- it hands off to the rail below once it reaches the facilitator."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          {personas.map(persona => (
            <button
              key={persona.key}
              type="button"
              onClick={() => void run(persona.key)}
              disabled={status === "running"}
              className={cn(
                "rounded-full border border-border px-4 py-1.5 text-xs font-medium",
                "transition-[transform,background-color,color,opacity] duration-150 ease-[var(--ease-out)]",
                "active:scale-[0.97] disabled:opacity-50",
                activePersona === persona.key && status === "running"
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : "bg-muted text-foreground",
              )}
            >
              {persona.label}
            </button>
          ))}
        </div>

        <div className="min-h-[92px] rounded-md border border-border bg-background/60 p-3 font-mono text-[11px] leading-relaxed">
          {lines.length === 0 ? (
            <p className="text-muted-foreground">Idle -- run a persona above to see it live.</p>
          ) : (
            lines.map((entry, index) => (
              <p key={index} className={cn("console-line", lineTone(entry.kind))}>
                {entry.line}
              </p>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
