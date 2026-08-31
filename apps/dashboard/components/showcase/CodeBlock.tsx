"use client";

import { useState } from "react";

export function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable (insecure context, permission
      // denied) -- the code is still selectable/copyable by hand, so this
      // is a silent no-op rather than an error state.
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="rounded-full border border-border px-3 py-1 text-[11px] font-medium text-muted-foreground transition-[opacity,background-color] duration-150 ease-[var(--ease-out)] hover:bg-muted"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-relaxed text-foreground">{code}</pre>
    </div>
  );
}
