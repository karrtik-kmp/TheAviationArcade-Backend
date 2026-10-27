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

Blocked on Unity: Firebase Auth in Unity (BLK-10) and an integer build-number scheme. App side: sign in,
`PUT /v1/me`, issue/submit Rounds, show the server's award, retry safely on replay. Device testing needs a
reachable server (LAN or tunnel first; hosting is Phase 6).

### Phase 3 — Economy completion

| # | Job | State | Notes |
|---|---|---|---|
| 3.1 | Miles ledger | Not started | Append-only, idempotent refs; Round credits written as entries |
| 3.2 | Spending (hints, skips) | Not started | Prices from `../docs/points-progression.md`; overspend is a clean error |
| 3.3 | Flight Segment set bonuses | Blocked | Josh: per Module? does a hint break Perfect Manifest? |
| 3.4 | Rule rulings | Blocked | Josh: hint vs streak, per-Module/rank minimum Round time |

### Phase 4 — Purchases

Needs App Store Connect / Play Console access and credentials. First Class Pass subscriptions,
consumables, Status Point boosts (refund reverses only an unused boost; confirm "used"), Apple ASSN v2 and
Google RTDN. Design in ARCHITECTURE.md.

### Phase 5 — Content releases

Admin-approved packages from the website → versioned release + rollback; Rounds tied to a release;
server-side answer checks (closes the client-reported-results gap). Needs the website export format.

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
- 2026-10-27: Chief Pilot is certified at 400,000 SP (user ruling; matches the Unity app).

## Open questions for Josh

See README "Open questions". Also: Apple's App Store guidelines generally require Sign in with Apple
when Google sign-in is offered; the project rule currently allows only email/password and Google.

## Verification log

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
