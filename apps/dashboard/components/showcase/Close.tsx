"use client";

/**
 * Section 7 -- repo link, plain link to /console (unlabeled -- no "the real
 * thing" framing), done. NEXT_PUBLIC_REPO_URL is read at build time (Next
 * inlines NEXT_PUBLIC_* env vars into the client bundle) -- this codebase
 * has no git remote configured anywhere (confirmed: not a git repository,
 * no `repository` field in any package.json), so a real URL can't be
 * pulled from anywhere in-repo. Rather than invent one, the link renders as
 * inert placeholder text until that env var is actually set.
 */

const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL;

export function Close() {
  return (
    <section className="relative flex min-h-[60vh] flex-col items-center justify-center gap-6 px-6 text-center">
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">fiat402</p>
      <div className="flex flex-wrap items-center justify-center gap-4 text-sm">
        {REPO_URL ? (
          <a href={REPO_URL} className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">
            repo
          </a>
        ) : (
          <span className="text-muted-foreground" title="set NEXT_PUBLIC_REPO_URL to link this">
            repo
          </span>
        )}
        <span className="text-border">·</span>
        <a href="/console" className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">
          /console
        </a>
      </div>
    </section>
  );
}
