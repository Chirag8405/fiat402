/**
 * POST /api/console-auth -- checks a submitted passcode against
 * CONSOLE_PASSCODE and, on match, sets the gate cookie middleware.ts checks
 * for /console and /api/console/*. See lib/console-auth.ts's top comment for
 * the full design (why the cookie holds a hash, not the raw passcode; why
 * this fails closed when CONSOLE_PASSCODE is unset).
 *
 * No Max-Age/Expires on the cookie -- a plain session cookie, cleared when
 * the browser closes, per the task brief ("stored in a cookie ... for the
 * session so it doesn't re-prompt on every page load").
 */

import { CONSOLE_AUTH_COOKIE, consoleAuthCookieValue } from "../../../lib/console-auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "request body must be JSON" }, { status: 400 });
  }

  const passcode = (body as { passcode?: unknown } | null)?.passcode;
  if (typeof passcode !== "string" || !passcode) {
    return Response.json({ error: "passcode is required" }, { status: 400 });
  }

  const expectedPasscode = process.env.CONSOLE_PASSCODE;
  if (!expectedPasscode) {
    return Response.json({ error: "CONSOLE_PASSCODE is not configured on this deployment" }, { status: 503 });
  }

  if (passcode !== expectedPasscode) {
    return Response.json({ error: "incorrect passcode" }, { status: 401 });
  }

  const cookieValue = await consoleAuthCookieValue();
  const response = Response.json({ ok: true });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.headers.append("Set-Cookie", `${CONSOLE_AUTH_COOKIE}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax${secure}`);
  return response;
}
