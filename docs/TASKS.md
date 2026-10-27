# Backend task board

| Job | State | Evidence / next action |
|---|---|---|
| First slice on Cloudflare Worker (Hono + D1) | Superseded | 2026-10-27: identity, progress, Rounds, review fixes; 66 tests. Replaced by the Node platform |
| Architecture baseline vs nodeDemo | Done | [ARCHITECTURE.md](ARCHITECTURE.md): what to adopt/adapt/reject, layout, purchases design |
| Re-platform to NestJS + PostgreSQL (Drizzle, Docker Compose) | Done (local) | NestJS 12.1.3, Postgres 18.4, Drizzle 0.45.4; row-locked transactions; `ApiError` + request id + JSON log line. Independent review pending |
| Hosting choice and deployment | Deferred | Local only for now (decided 2026-10-27); revisit before Unity integration testing on devices |
| Unity client integration | Not started | Firebase Auth in Unity, call `PUT /v1/me`, start/submit Rounds; `X-Client-Version` gate; OpenAPI contract |
| Content releases to the game | Not started | Admin-approved packages → versioned release + rollback; tie Rounds to a release; server-side answer checks |
| Miles ledger and spending (hints, skips) | Not started | Append-only ledger with idempotent refs; overspend as a clean error |
| Flight Segment set bonuses | Blocked | Needs Josh: per module? does a hint break Perfect Manifest? |
| Purchases / First Class Pass entitlements | Not started | Design in ARCHITECTURE.md. Sandbox purchases grant real rewards (decided) |
| Status Point boosts | Not started | Refund reverses only an unused boost (decided); confirm what "used" means |
| Rate limiting | Not started | `@nestjs/throttler`, shared store once multi-instance |
| Account deletion | Not started | App Store requirement; rounds cascade on player delete; Apple token revocation if SIWA |
| Leaderboards, Callsign/game identity contract | Not started | Needs the shared-identity ruling; consider email verification for ranked play |

## Decisions

- 2026-10-27: backend runs as a separate Node server (NestJS + PostgreSQL), not on Cloudflare.
- 2026-10-27: runs locally only for now; no hosting yet.
- 2026-10-27: sandbox (TestFlight / App Review) purchases grant real rewards in production.
- 2026-10-27: a refunded Status Point boost is reversed only if unused.

## Open questions for Josh

See README "Open questions". Also: Apple's App Store guidelines generally require Sign in with Apple
when Google sign-in is offered; the project rule currently allows only email/password and Google.

## Verification log

- 2026-10-27 (NestJS + Postgres): in the repo after a clean `npm ci` — typecheck clean, `nest build`
  clean, `npm test` 42/42 (rules + tokens), `npm run test:e2e` 28/28 against Postgres 18.4 in Docker
  (all ported API tests + request-id, malformed JSON, unknown route; 3× concurrent same-Round submit over
  real sockets → exactly one banked). Implementer smoke test of `node dist/main.js`: health 200, no token
  401, `PUT /v1/me` 201, too-fast 429 + `Retry-After`, banked 70/70 after 3 s, replay true. Local only.

- 2026-10-27 (Worker slice, superseded): typecheck clean; 66/66 tests in workerd against local D1;
  `wrangler dev` smoke test passed. Local evidence only; nothing deployed.
