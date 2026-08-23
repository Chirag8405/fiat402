"use client";

import { cn } from "../lib/utils";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

const LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
};

export function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium">
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          status === "live" && "bg-success live-pulse",
          status === "reconnecting" && "bg-warning animate-pulse",
          status === "connecting" && "bg-muted-foreground",
        )}
      />
      <span className={cn(status === "reconnecting" && "text-warning", status === "live" && "text-success")}>{LABEL[status]}</span>
    </div>
  );
}
