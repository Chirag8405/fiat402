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
 */

import { useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { cn } from "../lib/utils";

type LineKind = "info" | "success" | "error";

interface ConsoleLine {
  line: string;
  kind: LineKind;
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

function lineTone(kind: LineKind): string {
  if (kind === "error") return "text-danger";
  if (kind === "success") return "text-success";
  return "text-muted-foreground";
}

export function AgentConsole() {
  const [activePersona, setActivePersona] = useState<string | null>(null);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  // Guards against a stale stream (from a previous run) still writing lines
  // after a newer run has started -- only the latest run's reader is allowed
  // to touch state.
  const runIdRef = useRef(0);

  async function run(personaKey: string): Promise<void> {
    const runId = ++runIdRef.current;
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
          if (!isConsoleLine(parsed)) continue;
          if (parsed.kind === "error") sawError = true;
          setLines(prev => [...prev, parsed]);
        }
      }

      if (runIdRef.current === runId) setStatus(sawError ? "error" : "done");
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setLines(prev => [...prev, { line: err instanceof Error ? err.message : String(err), kind: "error" }]);
      setStatus("error");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent console</CardTitle>
        <CardDescription>Trigger a real agent request -- it hands off to the rail below once it reaches the facilitator.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          {PERSONAS.map(persona => (
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
