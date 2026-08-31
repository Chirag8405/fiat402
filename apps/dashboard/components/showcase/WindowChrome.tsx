"use client";

/**
 * Three-dot window-chrome header strip, shared by ColdOpen's JSON preview
 * panel and Bridge's crossfade card so the "bordered card with a chrome
 * strip" language (composition redesign) isn't duplicated twice. Muted
 * (not traffic-light red/yellow/green) to stay inside the monochrome
 * palette from the previous visual-language pass.
 */
export function WindowChrome({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
      <span className="flex gap-1.5" aria-hidden="true">
        <span className="h-2 w-2 rounded-full border border-border" />
        <span className="h-2 w-2 rounded-full border border-border" />
        <span className="h-2 w-2 rounded-full border border-border" />
      </span>
      {label ? <span className="ml-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">{label}</span> : null}
    </div>
  );
}
