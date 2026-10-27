# Airplane Games — game backend

The server the mobile app (Unity, `C:\Unity\Projects\AviationArcade`) calls for player identity and
progress. A standalone Node server — **NestJS + PostgreSQL (Drizzle)** — verifying Firebase ID tokens from
the same Firebase project the website (`../website`) uses, so a player is one principal across app,
website and backend. Deployed separately from the website. Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

This slice covers **player identity and progress** only. Content delivery, purchases, Flight Segment
bonuses, leaderboards and the community forum are later slices — see [docs/TASKS.md](docs/TASKS.md).

## Setup

Node >= 22.13 (24 preferred), Docker Desktop running. Run everything from this directory.

```sh
npm ci                        # install the locked dependencies
cp .env.example .env          # once; local-only values, git-ignored
docker compose up -d          # Postgres 18 on 127.0.0.1:5433 (dev db + airplane_games_test)
npm run db:migrate            # apply drizzle/ migrations to the dev database
```

Host port is **5433** because 5432 is often taken by another local Postgres.

## Commands

```sh
npm run start:dev             # watch mode, http://127.0.0.1:3000
npm run build && npm start    # compiled server (dist/main.js)
npm run typecheck             # tsc --noEmit
npm test                      # unit tests: rules + token verification (no database)
npm run test:e2e              # API tests against airplane_games_test (refuses any db not ending _test)
npm run db:generate           # new migration from src/db/schema.ts (never edit an applied one)
```

`.env` points at `demo-airplane-games` and accepts unsigned Firebase Auth Emulator tokens. Start the
emulator from the website repo (`npm run auth:emulator` in `../website`, port 9099) and sign in there to
mint tokens. Emulator tokens are honoured only for exactly `demo-airplane-games`; the production project
can never accept them.

### Configuration

| Variable | Notes |
|---|---|
| `APP_ENV` | Required: `local`, `test` or `production`. `.env` is never loaded when it is `production` |
| `DATABASE_URL` | Postgres connection string |
| `FIREBASE_PROJECT_ID` | `demo-airplane-games` locally; `airplane-games-auth-20261022` in production |
| `ALLOW_EMULATOR_TOKENS` | Local only. Production refuses to boot with it on, or with a `demo-` project |
| `HOST` / `PORT` | Default `127.0.0.1` / `3000`. Use `0.0.0.0` inside a container |
| `DB_POOL_MAX` | Default 10. Statement/lock timeouts 5 s, idle-in-transaction 15 s |
| `DATABASE_SSL` | `disable` / `require` / `verify-full`. Default `disable` locally; production accepts only `verify-full`. `require` encrypts without checking the certificate. Never put `sslmode`, `sslnegotiation` or other ssl parameters in `DATABASE_URL`: startup fails |
| `DATABASE_CA_CERT` | Optional PEM trusted for the server certificate (`verify-full` only); literal `
` become newlines. Without it, system roots |
| `TRUST_PROXY` | Default `false`. Reverse-proxy hops to trust for the client IP (`1`–`99`). Set only behind a proxy you control, or clients can spoof their IP. Production logs a warning while it is off |
| `RATE_LIMIT_AUTH_PER_MIN` / `RATE_LIMIT_PUBLIC_PER_MIN` | Defaults 120 / 60 per sliding 60 s window; excess requests are refused only while over the limit (no lockout). Authenticated routes share one budget per principal; public routes are per IP. Health routes exempt. In memory, so per instance |
| `MIN_CLIENT_BUILD` | Optional, 1–999999999. When set, requests need `X-Client-Version: <build>` at or above it, else 426. Health routes and `DELETE /v1/me` exempt. Unset = gate off (build scheme undecided) |
| `SHUTDOWN_DRAIN_MS` | Default 10000. On SIGTERM/SIGINT: `/v1/health/ready` turns 503, then the server stops accepting, finishes in-flight requests (answering `Connection: close`), closes the pool and exits 0; exit 1 past the deadline; a second signal exits at once |
| `SHUTDOWN_PRESTOP_MS` | Default 5000 in production, 0 elsewhere. How long `/ready` reports 503 before the listener closes, so load balancers stop routing first. Counts inside `SHUTDOWN_DRAIN_MS`; both must stay below the host's termination grace period (Kubernetes default 30 s) |

The server runs locally only for now; hosting is not chosen.

### Container

`docker build -t airplane-games-backend:local .` builds a non-root image running `node dist/main.js` on
`0.0.0.0:3000`. It does not contain migrations: run `npm run db:migrate` from a repo checkout or CI (it needs dev
dependencies) against the target database before rolling out the new image; a migrate image target is
Phase 6. It
contains no `.env` file: supply `APP_ENV`, `DATABASE_URL`, `FIREBASE_PROJECT_ID` and the rest through the
environment. Node's keep-alive/headers/request timeouts (65/66/70 s) sit above the usual 60 s proxy idle
timeout; see `src/platform/server-timeouts.ts`.

## API

The contract is [docs/openapi.yaml](docs/openapi.yaml), kept in step with the code by a parity test.
All endpoints except health need `Authorization: Bearer <Firebase ID token>`. Errors are
`{ "error": { "code", "message", "requestId" } }`; every response carries `X-Request-Id`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/health` | Liveness, public. No database, not rate limited |
| GET | `/v1/health/ready` | Readiness, public, not rate limited: `SELECT 1` within 2 s (cached ~1 s), else (or while shutting down) 503 `service_unavailable` |
| PUT | `/v1/me` | Sign-in handshake. Creates the player on first call (201), else 200. Returns progress |
| GET | `/v1/me/progress` | Progress. 404 `player_not_found` until `PUT /v1/me` |
| PUT | `/v1/me/active-rank` | `{ rank }`. Dial Active Rank down (Pleasure Cruise) or back to Certified. 403 above Certified |
| POST | `/v1/rounds` | `{ module }`. Issues a single-use Round; abandons any other open Round |
| DELETE | `/v1/me` | Account deletion: erases the player and its Rounds. 204 whether or not a player existed |
| POST | `/v1/rounds/:id/result` | `{ finished, errorCount, usedHint, timeRemainingFraction }`. Scores and banks it |

Result status codes: 200 banked (or `replayed: true` for a Round already banked — safe to retry),
404 not this player's Round, 410 expired or abandoned, 429 submitted too soon after issue (retry after
`Retry-After`), 503 `auth_unavailable` when Google's signing keys cannot be fetched, 503
`service_unavailable` when the database is unreachable or times out (both with `Retry-After`).
Unknown routes are 404 `not_found`. Bodies are JSON only, at most 16 KB: malformed or extra-field
bodies are 400 `invalid_request`, oversized 413, wrong charset/encoding 415 (same code). 401s carry
`WWW-Authenticate: Bearer`; `/v1` responses other than health are `Cache-Control: no-store`.

Any route can also return 429 `rate_limited` (with `Retry-After`; distinct from `round_too_fast`), and,
when `MIN_CLIENT_BUILD` is set, 426 `client_update_required` (checked before authentication; health
routes and `DELETE /v1/me` exempt, so an outdated app can still delete its account). `POST /v1/rounds`
returns 201.

Ranks and module IDs on the wire are kebab-case: `trainee`, `first-officer`, `captain`, `check-airman`,
`chief-pilot`; modules follow the Unity ModuleRegistry and website catalog (`atc-match`, `identifier`,
`military-identifier`, …) — see `src/rules/`.

## Design rules

- **Identity.** The principal is `firebase:<projectId>:<uid>`, taken only from a verified token. Email
  and password and Google are the only accepted providers. No email, display name or Callsign is
  stored here; the Callsign/game-identity contract is a later, separate decision.
- **The server is authoritative for the economy.** The client reports only what happened in a Round.
  Perfect Streak, First Class Pass and Pleasure Cruise are decided server-side, and request bodies are
  strict, so extra fields are rejected.
- **Bank once, never lose a write.** A Round closes and the player is credited in one Postgres
  transaction that first locks the player row (`SELECT … FOR UPDATE`), then the Round. Lock order is
  always player → Round. Every balance change bumps `players.version`.
- **Account deletion** erases only this backend's data. The app deletes the Firebase account itself (the
  backend holds no Firebase admin credentials); until it does, a still-valid token plus `PUT /v1/me`
  creates a fresh player at zero. The delete takes the player lock first, so an in-flight Round result
  either banks before it or gets 404 after.
- **Rules mirror Unity.** `src/rules/` ports `ScoreCalculator`, `FlightRank` and `PilotProgression`.
  Change both together. Test names match the Unity tests.
- **Spec ambiguities are asserted, not buried** (Unity ADR-0004). Each is a test named `ASSUMPTION: …`.

## Known limitations of this slice

Results are client-reported. Server-issued single-use Rounds, one open Round per player, a minimum
Round duration and server-side streak/multiplier logic bound the damage, but a modified client can still
report perfect play. Checking answers server-side arrives with the content-release slice. Token
revocation is not checked: a disabled account's token works until it expires (about an hour).

## Open questions for Josh

Asserted in code and tests until ruled:

1. Chief Pilot threshold: **200,000 SP** used (spec also says 400,000). ⚠️ The Unity app currently uses
   **400,000** (flagged in its IMPLEMENTATION_STATUS), so app and server disagree until Josh rules.
2. Speed bonus additive with completion award (spec's worked example implies it).
3. Pleasure Cruise cap applied before the First Class multiplier.
4. Unfinished Round pays nothing and breaks the streak (Unity prototype ruling).
5. Streak Miles pay on the streak carried *into* a Round, even if that Round breaks it (matches Unity).
6. Does a hint break the Perfect Streak? Server says yes (a hinted Round is not a Perfect Completion);
   Unity's `AtcMatchScreen` currently advances the streak on zero errors alone.
7. Minimum Round duration is a provisional 3 s; needs per-module/per-rank timer lengths. Source of
   truth is the app's TripProfiles (e.g. ATC Match 15/20/25 s, Call Sign 15/20/20/15/15 s by rank); no
   consolidated table yet.
