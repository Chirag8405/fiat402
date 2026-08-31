"use client";

/**
 * Plain passcode form for /console -- POSTs to /api/console-auth, which sets
 * the gate cookie middleware.ts checks, then redirects to `redirect` (set by
 * middleware.ts to whatever /console/* or /api/console/* path was originally
 * requested) or /console itself as the default target.
 */

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function ConsoleLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/console-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `request failed with status ${res.status}`);
        setSubmitting(false);
        return;
      }
      const redirect = searchParams.get("redirect");
      router.push(redirect && redirect.startsWith("/console") ? redirect : "/console");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">fiat402 console</h1>
        <p className="text-xs text-muted-foreground">Enter the passcode to access the live control tower.</p>
      </div>
      <form onSubmit={event => void handleSubmit(event)} className="flex flex-col gap-3">
        <input
          type="password"
          autoFocus
          value={passcode}
          onChange={event => setPasscode(event.target.value)}
          placeholder="Passcode"
          className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={submitting || !passcode}
          className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity disabled:opacity-50"
        >
          {submitting ? "Checking…" : "Enter"}
        </button>
        {error && <p className="text-xs text-danger">{error}</p>}
      </form>
    </main>
  );
}

export default function ConsoleLoginPage() {
  return (
    <Suspense>
      <ConsoleLoginForm />
    </Suspense>
  );
}
