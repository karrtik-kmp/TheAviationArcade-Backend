# Backend task board

Done so far:

| Job | State | Evidence |
|---|---|---|
| First slice on Cloudflare Worker (Hono + D1) | Superseded | 2026-10-27: replaced by the Node platform |
| Architecture baseline vs nodeDemo | Done | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Re-platform to NestJS + PostgreSQL (Drizzle, Docker Compose) | Done (local) | Commit 80fbaa7 |
| NestJS review fixes | Done (local) | Commit fd52d3e |

## Roadmap (phases, agreed order 2026-10-27)

### Phase 1 — Ready for the app (no outside blockers) — done (local, uncommitted)

| # | Job | State | Scope |
|---|---|---|---|
| 1.1 | Production basics | Done (local) | `GET /v1/health/ready` (DB probe); shutdown drain deadline, keepAlive/headers timeouts; `TRUST_PROXY`; optional Postgres SSL; Dockerfile + `.dockerignore` (excludes `.env*`); ignore service-account JSON |
| 1.2 | Rate limiting | Done (local) | `@nestjs/throttler`, keyed by principal (IP on public routes), in-memory store; 429 `rate_limited` + `Retry-After` |
| 1.3 | Client version gate | Done (local) | `X-Client-Version` integer vs optional `MIN_CLIENT_BUILD` → 426 `client_update_required`; off while unset (build scheme undecided) |
| 1.4 | Account deletion | Done (local) | `DELETE /v1/me` under the player lock; Rounds cascade. Firebase account deletion stays in the app (Firebase SDK) |
| 1.5 | API contract | Done (local) | `docs/openapi.yaml` + parity test (every route, status and error code). After 1.1–1.4 |

### Phase 2 — Unity client integration

Unblocked on policy: Unity ADR-0006 was Accepted 2026-10-27 (D1–D7; BLK-10 decided) and CON-03 makes this
repo's `docs/openapi.yaml` the app's account contract. Build number decided: `X-Client-Version` = Android
`versionCode` = iOS `buildNumber`, one increasing integer. Tokens: `FirebaseUser.TokenAsync`; on 401 refresh
once, then re-authenticate. Policies that touch the backend: sign-in required before any scored Round, no
Anonymous Auth (D1); no demo-progress import, accounts start from `PUT /v1/me` 201 (D2); deletion = re-auth,
`DELETE /v1/me` (204, 426-exempt), then `FirebaseUser.DeleteAsync()` (D3); a signed-out player's open Round
just expires (30 min); iOS offers email/password only for v1 (D5). Unity has uncommitted `UnityHttpApiClient`
work reading `error.code`, `Retry-After` and `requestId`, and adding PUT/DELETE. App side still: sign in,
`PUT /v1/me`, issue/submit Rounds, show the server's award, retry safely on replay. Device testing needs a
reachable server (LAN or tunnel first; hosting is Phase 6).

Backend side is ready for real tokens from `airplane-games-auth-20261022` (README, "Commands").
Registered 2026-10-27 (user sign-off) in that project: Android `1:657564884414:android:f166e2432061335ef2adef`
and iOS `1:657564884414:ios:741c0e926d1b0fb5f2adef`, both `com.airplane.games`. Config files are in
`H:\Work\TheAviationArcade\firebase-apps\` (outside every repo). Missing, all outside this repo: the
Android signing key's SHA-1/SHA-256 (then re-download `google-services.json`), Apple Team ID, Firebase Unity SDK, sign-in
screens, `Authorization`/`X-Client-Version` headers in `UnityHttpApiClient`, and a per-build base URL.

Module IDs on the wire are the Unity `ModuleRegistry` BackendIds. Unity split Commercial/Military on
2026-10-23 (`bd67f06`) and sends `aircraft-identifier-military`; the backend accepted only
`military-identifier` until migration 0002 (2026-10-28). The website catalog still keys it `military-identifier`.

### Phase 3 — Economy completion

| # | Job | State | Notes |
|---|---|---|---|
| 3.1 | Miles ledger | Not started | Append-only, idempotent refs; Round credits written as entries |
| 3.2 | Spending (hints, skips) | Not started | Prices from `../docs/points-progression.md`; overspend is a clean error |
| 3.3 | Flight Segment set bonuses | Blocked | Josh: per Module? does a hint break Perfect Manifest? |
| 3.4 | Rule rulings | Blocked | Josh: per-Module/rank minimum Round time (the app still owes the timer table; 3 s floor stays). Hint vs streak: the app now agrees with the server (a hinted Round is Standard and breaks the streak, Unity `9576a63`); the ruling itself is still Josh's |
| 3.5 | Field Awards | Not started | Client source is now `../docs/Field Awards #1.xlsx` (2026-10-28, 28 rows; supersedes `Draft_for_FieldAwards v2.xlsx`: Go Around is redefined as a full green Trip after a non-full one, Quad-Engine Royalty lists military types). Awards pay no Miles or Status Points. Use exactly the client's rows; Unity owns the catalog |

### Phase 4 — Purchases

Needs App Store Connect / Play Console access and credentials. First Class Pass subscriptions,
consumables, Status Point boosts (refund reverses only an unused boost; confirm "used"), Apple ASSN v2 and
Google RTDN. Design in ARCHITECTURE.md.

### Phase 5 — Content releases

Admin-approved packages from the website → versioned release + rollback; Rounds tied to a release;
server-side answer checks (closes the client-reported-results gap). Needs the website export format.
Package files and images live in Bunny Storage (zone choice: share the website's or a new one, sign-off).

### Phase 6 — Hosting and launch

Choose host + managed Postgres (needs sign-off). DB clock for Round timing across instances, shared
rate-limit store, SSL/pool sizing, backups/PITR, monitoring, deploy runbook.

### Phase 7 — Community

Leaderboards and the Callsign/game-identity contract (needs the shared-identity ruling; consider
verified email for ranked play).

## Decisions

- 2026-10-27: backend runs as a separate Node server (NestJS + PostgreSQL), not on Cloudflare.
- 2026-10-27: runs locally only for now; no hosting yet.
- 2026-10-27: sandbox (TestFlight / App Review) purchases grant real rewards in production.
- 2026-10-27: a refunded Status Point boost is reversed only if unused.
- 2026-10-27: file/blob storage is Bunny Storage (S3 API), as on the website; private by default.
  See ARCHITECTURE.md "File storage".
- 2026-10-27: Chief Pilot is certified at 400,000 SP (user ruling; matches the Unity app).
- 2026-10-28: module IDs on the wire are exactly the Unity `ModuleRegistry` BackendIds (Military =
  `aircraft-identifier-military`, migration 0002). Final Military name/ID still a working title.
- 2026-10-27: backend Postgres owns all progress; UGS keeps no copy (no Cloud Save mirror, no UGS
  Economy). Firebase-OIDC link and webhooks only if a UGS service is adopted. See ARCHITECTURE.md.

## Open questions for Josh

See README "Open questions". Also: Apple's App Store guidelines generally require Sign in with Apple
when Google sign-in is offered; the project rule currently allows only email/password and Google.

## Verification log

- 2026-10-28 (Military module ID): `npm run typecheck` clean, `npm test` 91/91, `npm run db:migrate`
  applied 0002 to local Postgres, `npm run test:e2e` 77/77 (new: a Round issued and banked for every module
  ID; the old `military-identifier` is 400). Migration generated by drizzle-kit plus a hand-added `UPDATE` of
  old rows between the drop and re-add of the check. Local only.

- 2026-10-27 (real Firebase project, local): `node dist/main.js` with
  `FIREBASE_PROJECT_ID=airplane-games-auth-20261022`, `ALLOW_EMULATOR_TOKENS=false`: boots, `/ready` 200,
  securetoken JWKS reachable (200), garbage token 401, unsigned `alg:none` token for that project 401. Not
  verified: a real signed-in token (needs an account in the cloud project). No code change.

- 2026-10-27 (Phase 1): implemented by subagents, independent Opus review (3 real defects: shutdown hung
  on keep-alive sockets; `DATABASE_URL` could bypass the SSL rules; readiness flipped as the listener
  closed; plus 9 smaller items), all fixed and re-tested. My run: typecheck and `nest build` clean,
  `npm test` 91/91, `npm run test:e2e` 76/76 (api, platform, openapi parity), `docker build` OK, no
  secrets or `.env` staged. Drift check: renaming a route or a rank in `docs/openapi.yaml` fails the
  parity test. Not verified: TLS Postgres handshake, a real load balancer, SIGTERM to a live container
  with a request in flight (tested through `drain()`), production timing defaults. Local only.

- 2026-10-27 (review fixes): typecheck and `nest build` clean; `npm test` 70/70; `npm run test:e2e`
  47/47 (incl. deterministic player-lock tests via a second connection, concurrent `PUT /v1/me` → one
  201, issue/result storm, 413/415, Bearer variants, every route 401 without a token). Implementer
  verified `APP_ENV=production` refuses emulator tokens and demo projects. Local only.

- 2026-10-27 (NestJS + Postgres): in the repo after a clean `npm ci` — typecheck clean, `nest build`
  clean, `npm test` 42/42 (rules + tokens), `npm run test:e2e` 28/28 against Postgres 18.4 in Docker
  (all ported API tests + request-id, malformed JSON, unknown route; 3× concurrent same-Round submit over
  real sockets → exactly one banked). Implementer smoke test of `node dist/main.js`: health 200, no token
  401, `PUT /v1/me` 201, too-fast 429 + `Retry-After`, banked 70/70 after 3 s, replay true. Local only.

- 2026-10-27 (Worker slice, superseded): typecheck clean; 66/66 tests in workerd against local D1;
  `wrangler dev` smoke test passed. Local evidence only; nothing deployed.
