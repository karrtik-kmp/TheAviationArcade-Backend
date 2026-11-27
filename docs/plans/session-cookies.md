# Plan: Firebase session cookies as a website credential (API 0.35.0)

**Status:** plan gate passed with changes (senior-lead, backend-expert), 2026-11-27. Building.
**Brief:** `../../docs/briefs/backend-session-cookie-credential.md`, which serves the website plan
`../../website/docs/SESSION_COOKIES_PLAN.md` (D2, D3, S1).
**Prerequisite:** Apple sign-in, landed on `main` as `696fe9e` (user: "let it finish Apple", 2026-11-27).

## Facts checked (2026-11-27, primary sources)

- Session cookie = RS256 JWT, `iss` `https://session.firebase.google.com/<projectId>`, `aud` `<projectId>`, same claims as the
  source ID token (including `auth_time`, `firebase.*`). Lifetime 300 s – 1,209,600 s (2 weeks).
  Sources: firebase.google.com/docs/auth/admin/manage-cookies; firebase-admin-node v14.5.1 `src/auth/token-verifier.ts`.
- Keys: `https://www.googleapis.com/identitytoolkit/v3/relyingparty/publicKeys`, a `{ kid: X.509 PEM }` map, cached by
  `Cache-Control: max-age` (website checked live: `max-age=86400`; HEAD answers 404). Not a JWKS. The SDK falls back to trying
  every key when `kid` is missing; we don't copy that: no `kid` = invalid.
- Revocation as in firebase-admin `verifySessionCookie(checkRevoked)`: `getUser(sub)`; `disabled` → refuse; `validSince`
  (string, seconds) present and `auth_time < validSince` → revoked. REST `accounts:lookup` needs `firebaseauth.users.get`,
  scope `cloud-platform` (already used). The existing `backend-grant` key has `roles/firebaseauth.admin`, which holds it.
- Emulator (firebase-tools `operations.ts`): `createSessionCookie` signs `alg: none` with the same `iss` form; jose never accepts
  `none`, so the emulator path decodes and checks claims itself, as the ID-token emulator path does today.
- jose 6.2.13 (pinned; installed `.d.ts` checked): `importX509(pem, "RS256")` → `CryptoKey`; `jwtVerify` accepts a function key
  resolver; `decodeJwt` throws on malformed input. Releases 6.2.14–6.2.18 are JWE/JWKS fixes and hardening, none on our RS256
  JWS path. **No bump in this wave.**

## Decisions (revised after the plan gate, 2026-11-27: senior-lead and backend-expert, both "approve with changes")

| # | Decision | Why |
|---|---|---|
| C1 | One `verifyCredential(token, options)` in `src/auth/firebase.ts` returns `{ identity, kind: "idToken" \| "sessionCookie" }`. It reads the **unverified** `iss` only to choose the kind, by exact match: `https://session.firebase.google.com/<projectId>` → session path, anything else → the existing ID-token path (which refuses a foreign `iss`). Each kind verifies with its own fixed issuer, its own key set and RS256 only. The emulator (`alg: none`) path picks the validator the same way. `verifyFirebaseToken` stays as the ID-token path. | Brief items 1–2 |
| C2 | Session-cookie claims: the ID-token rules (`sub`, `iat`, `auth_time`, `exp`, aud, iss) plus `exp > iat` and `exp − iat ≤ 1,209,600`. Providers `password`, `google.com`, `apple.com` only; `anonymous` (guest **or** linked) → invalid, whatever `FIREBASE_ANONYMOUS_PLAYERS` says. | Brief item 2; D2 |
| C3 | Session key resolver: fetch the X.509 map (**timeout 3 s**), `importX509` each into a `Map<string, CryptoKey>` (own keys only; header `kid` must be a non-empty string ≤ 128), cache for `max-age` (only a `max-age=<digits>` directive counts; clamp 60 s – 24 h; otherwise 60 s); one fetch in flight. **Unknown `kid`**: refetch (sharing the single flight) at most once per 60 s; still unknown after a fresh fetch → 401 (`JWKSNoMatchingKey`); unknown during the cooldown → 503, so a random `kid` cannot make the website clear real members' cookies while Google rotates keys. **Fetch/parse/import failure** → `AuthUnavailableError` (503); after a failed refresh keep serving the last good set for at most its max-age + 1 h; with no good set, back off 5 s (503) before fetching again. | Brief items 2, 5; gate |
| C4 | **Route allowlist** by `@SessionCookieAllowed()` on **handlers only** (never a class), exactly nine: `GET /v1/me/roles`, `POST /v1/me/roles/photographer`, `GET /v1/me/progress`, and the six media routes the website calls (website `lib/request/media-routes.ts`): `GET /v1/admin/media`, `GET /v1/admin/media/:mediaId`, `POST /v1/admin/media`, `POST /v1/admin/media/:mediaId/versions`, `PATCH /v1/admin/media/:mediaId`, `PUT /v1/admin/media/:mediaId/rights`. `publish`, `review`, `withdraw` stay ID-token only (the Admin keeps ID tokens until its own S6 brief). Any other route answers 401 to a session cookie before any lookup. A test collects the decorated handlers from every registered controller and compares them with this literal list. | Brief item 3; gate (least privilege) |
| C5 | **Revocation**: `SessionRevocation` in `src/accounts/session-revocation.ts`, provided **and exported** by `AccountsModule` (injects `FIREBASE_ACCOUNTS`, `APP_CONFIG`); nothing in `src/accounts` imports `src/auth`. `IdentityToolkitAccounts` gets `lookupSessionState(uid, signal)` → `{ kind: "found", disabled, validSince: number \| undefined } \| not_found \| unavailable`. **One 3 s deadline** (one `AbortSignal`) covers the OAuth token mint and the lookup; one try (no retry on the request path: `callOnce` with the caller's signal); one in-flight token mint shared by all callers; one in-flight lookup per uid. **Strict parsing**: a 200 whose body is not a JSON object, or whose `users` is present but not an array → `unavailable`; well-formed with no matching `localId` → `not_found` (ASSUMPTION test: firebase-admin also refuses). `disabled` absent = false, a boolean = itself, anything else → `unavailable`. `validSince` absent = never revoked; a string matching `^[0-9]{1,15}$` = seconds; anything else → `unavailable`. **Cache** per `projectId:uid`, 60 s, max 10,000 entries (oldest evicted), of every **definitive** answer: an OK (not disabled, plus its `validSince`; each request still compares its own `auth_time`), and `disabled` / `not_found` cached **as refusals**, never as OK. Errors are never cached. Revoked = `auth_time < validSince`. A disable or revoke can take up to 60 s to bite after a cached OK (brief allows ≤ 60 s; documented in ARCHITECTURE.md). | Brief item 4; gate (quota DoS, deadline, parsing) |
| C6 | **Order and answers** in one helper `authenticate()` (`src/auth/authenticate.ts`), used by `FirebaseAuthGuard` and `roleBodyReader`: (1) verify signature and claims → 401, or 503 (keys); (2) session cookie on a route not allowed → 401; (3) count the request against the per-principal rate limit (`countAuthenticatedRequest`, which marks it so `RateLimitGuard` skips it) → 429; (4) no Admin credential (`config.firebaseAdmin` undefined) → **503 `auth_unavailable`, `Retry-After: 60`**; (5) revocation → 401 (disabled, revoked, not found) or 503 `auth_unavailable` `Retry-After: 5` (lookup unavailable). ID tokens skip 2, 4 and 5 and keep today's behaviour (their count stays in `RateLimitGuard`). 503 for a missing key is a deliberate reading of brief item 5: the cookie is refused, but a 401 would make the website clear every member's cookie for an operator error; told to the website in the release reply. `SessionRevocation`'s provider logs one error at start when `firebaseAdmin` is unset. Failure logs are throttled (the first, then a count at most every 30 s). | Brief item 5; gate |
| C7 | **Emulator**: an `alg: none` session cookie only under `emulatorTokensAllowed` (flag + `demo-airplane-games`); revocation then asks the Auth Emulator (`firebaseAdmin.kind === "emulator"`). Without emulator admin config → 503 as C6. | Brief item 7 |
| C8 | **Body reader**: `roleBodyReader` gets `sessionCookies: boolean`, true only for the media upload reader. Order as C6, then `RolesService.authorize`, then the body read, so a revoked cookie gets 401 before any byte is buffered. The xlsx, coverage and FAQ readers answer 401 to a cookie with no lookup. The guard's second check of the same request is served from the cache. Sets `req.credentialKind`. | Brief item 1; gate |
| C9 | Logs: `requestContext` logs rid, ip, method, route pattern, status, ms only; never headers. A test asserts the log line carries no bearer. | Brief item 8 |
| C10 | OpenAPI **0.35.0** (additive): changelog for Apple accounts (landed in `696fe9e`, spec not bumped then) and session cookies; a second security scheme `firebaseSessionCookie` (bearer, JWT) offered as an alternative only on the nine operations; 503 `auth_unavailable` documented on them; regenerate `contracts/`. | Brief item 9 |

Worst case on the request path: key refresh 3 s (about once a day) + lookup 3 s = 6 s; normally nothing (cached) or ≤ 3 s.
Told to the website (its D3 timeout is 4 s).

Not in this wave: game auth changes, `revokeRefreshTokens`, a jose bump, any env var (C6 uses the existing
`FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE`), a health-check field for the missing key.

## Slices (implementers, explicit file ownership)

| Slice | Owner files | Depends on |
|---|---|---|
| A. Verifier | `src/auth/firebase.ts`, `test/firebase.test.ts`, `test/session-cookie.test.ts` (new), `test/tokens.ts` (cookie helpers) | — |
| B. Revocation | `src/accounts/firebase-accounts.ts`, `src/accounts/session-revocation.ts` (new), `src/accounts/accounts.module.ts`, `test/firebase-accounts.test.ts`, `test/session-revocation.test.ts` (new) | — |
| C. Wiring | `src/auth/authenticate.ts` (new), `src/auth/firebase-auth.guard.ts`, `src/auth/session-cookie.decorator.ts` (new), `src/app.setup.ts`, `src/common/request-context.ts` (type only), the decorator on `src/accounts/accounts.controller.ts`, `src/players/players.controller.ts`, `src/content/media/media.controller.ts`; `test/session-cookie.e2e.test.ts` (new), `test/guard-filter.test.ts` | A, B |
| D. Contract | `docs/openapi.yaml`, `contracts/` (generated), `docs/ARCHITECTURE.md`, `README.md` | C |

A and B run in parallel; C after both; D last. I integrate and record `docs/TASKS.md`.

## Tests (brief item 10, plus the gate's)

Valid cookie (password, Google, Apple); wrong issuer; wrong audience; expired; `exp ≤ iat`; `exp − iat` > 14 days; ID-token key
on a cookie and cookie key on an ID token (both refused); missing `kid`; `kid: "__proto__"` → 401; unknown kid after a fresh
fetch → 401, during the cooldown → 503; key-fetch failure → 503, last good set served after a failed refresh, one fetch per 5 s
backoff; guest and linked-anonymous cookie refused with the anonymous flag on; cookie on a non-allowlisted route → 401 with no
lookup; disabled, not found and revoked (`auth_time < validSince`) → 401; bad `validSince` / `disabled` / body shapes → 503;
cache: OK reused within 60 s, refusals cached as refusals, errors not cached; concurrent cold requests → one token POST and one
lookup; slow mint → 503 within 3 s; a revoked cookie repeated → one lookup, then 429; no Admin key → 503; emulator rule (unsigned
cookie refused outside the demo project or without the flag); both call sites: guard route, media upload (revoked → 401 and the
reader never runs; one lookup per upload), a cookie on the xlsx import → 401 with no lookup; log line has no bearer; the
allowlist pinned from metadata; ID-token behaviour unchanged on every route.

## Rollout

Commit, push, then dev deploy **only with the user's sign-off**: check dev.api has `FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE` set
(else session cookies answer 503 there), deploy 0.35.0, smoke test with an ID token (unchanged) and a cookie on a non-allowlisted
route (401). Then tell the website session the version, the 503-for-missing-key reading, the 6 s worst case, and that 0.35.0 also
carries Apple accounts. No prod deploy in this wave.
