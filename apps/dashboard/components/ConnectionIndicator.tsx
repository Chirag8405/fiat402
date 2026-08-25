"use client";

import { cn } from "../lib/utils";

/**
 * Replaces the former SSE-specific "live"/"reconnecting" states (EventSource
 * had onopen/onerror callbacks to drive those) now that app/page.tsx polls
 * /api/events on a timer instead of holding a connection open:
 *   - "connecting": before the first poll has resolved.
 *   - "polling": the most recent poll succeeded; `lastPolledAt` shows when.
 *   - "connection-issue": the most recent poll failed (network error or a
 *     non-OK response) -- surfaced immediately, same as the old onerror
 *     behavior, rather than waiting for several consecutive failures, since
 *     the poll loop keeps retrying every cycle regardless.
 */
export type ConnectionStatus = "connecting" | "polling" | "connection-issue";

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}

export function ConnectionIndicator({ status, lastPolledAt }: { status: ConnectionStatus; lastPolledAt: string | null }) {
  const label =
    status === "connecting" ? "Connecting…" : status === "connection-issue" ? "Connection issue" : `Polling · last update ${formatTime(lastPolledAt) || "just now"}`;

  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium">
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          status === "polling" && "bg-success live-pulse",
          status === "connection-issue" && "bg-warning animate-pulse",
          status === "connecting" && "bg-muted-foreground",
        )}
      />
      <span className={cn(status === "connection-issue" && "text-warning", status === "polling" && "text-success")}>{label}</span>
    </div>
  );
}
