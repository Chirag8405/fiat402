/**
 * Shared "nothing to show yet" placeholder. Used both for the page-level
 * empty state (no events received at all) and, inside individual panels,
 * for fields the live `fiat402:events` schema simply doesn't carry (see
 * each panel's own top-of-file comment for which fields those are and why).
 */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[6rem] items-center justify-center rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">{children}</div>;
}
