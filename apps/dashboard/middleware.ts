/**
 * Passcode gate for /console (the real, live-triggering dashboard) and
 * /api/console/* (its supporting routes, e.g. app/api/console/export/
 * [requestId]/route.ts) -- see lib/console-auth.ts's top comment for the
 * full design.
 *
 * /console-login and /api/console-auth deliberately sit OUTSIDE both matcher
 * prefixes below (sibling path segments, "console-login"/"console-auth" vs
 * "console") -- they must stay reachable unauthenticated, since they're how
 * the cookie gets set in the first place.
 */

import { NextResponse, type NextRequest } from "next/server";
import { CONSOLE_AUTH_COOKIE, isValidConsoleAuthToken } from "./lib/console-auth";

export const config = {
  matcher: ["/console/:path*", "/api/console/:path*"],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(CONSOLE_AUTH_COOKIE)?.value;
  if (await isValidConsoleAuthToken(token)) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/console/")) {
    return NextResponse.json(
      { error: "unauthorized -- enter the console passcode at /console-login first" },
      { status: 401 },
    );
  }

  const loginUrl = new URL("/console-login", request.url);
  loginUrl.searchParams.set("redirect", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}
