import { SetMetadata } from "@nestjs/common";

export const SESSION_COOKIE_ALLOWED = "sessionCookieAllowed";

/**
 * Lets a Firebase session cookie (not only an ID token) authenticate this route (docs/plans/session-cookies.md C4). Place it on
 * HANDLERS only, never a class, and only on the nine routes the website calls; every other route answers 401 to a session cookie.
 * test/session-cookie.e2e.test.ts pins the exact list.
 */
export const SessionCookieAllowed = (): MethodDecorator => SetMetadata(SESSION_COOKIE_ALLOWED, true);
