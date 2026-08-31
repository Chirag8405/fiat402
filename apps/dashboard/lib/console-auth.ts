/**
 * Passcode-gate primitives shared between middleware.ts (edge runtime) and
 * app/api/console-auth/route.ts (node runtime) -- both runtimes expose the
 * same global Web Crypto `crypto.subtle`, so this file uses only that (never
 * Node's `crypto` module) to stay importable from both.
 *
 * Deliberately NOT full auth (per the task brief): one shared secret
 * (CONSOLE_PASSCODE), one cookie, no accounts/sessions/expiry beyond "cleared
 * when the browser closes" (a plain session cookie -- no Max-Age/Expires set
 * where it's issued, see app/api/console-auth/route.ts). Just enough that a
 * random visitor to the showcase page at "/" doesn't stumble onto
 * real-money-triggering buttons at /console.
 *
 * The cookie never carries the raw passcode -- only sha256(CONSOLE_PASSCODE),
 * so inspecting the cookie in devtools doesn't hand back the secret itself.
 * Unset CONSOLE_PASSCODE => the gate fails closed (every check returns
 * false/null), matching this codebase's existing fail-closed convention
 * (CLAUDE.md: "Redis unavailable = fail closed", "NEVER return 'approve' on
 * any failure path") rather than silently serving /console unauthenticated.
 */

export const CONSOLE_AUTH_COOKIE = "fiat402_console_auth";

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The cookie value a correct passcode should produce -- null if CONSOLE_PASSCODE isn't configured (fail closed). */
export async function consoleAuthCookieValue(): Promise<string | null> {
  const passcode = process.env.CONSOLE_PASSCODE;
  if (!passcode) return null;
  return sha256Hex(passcode);
}

/** Whether a cookie value read off an incoming request is the current valid one. */
export async function isValidConsoleAuthToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const expected = await consoleAuthCookieValue();
  return expected !== null && token === expected;
}
