# Airplane Games — game backend

The server the mobile app (Unity, `C:\Unity\Projects\AviationArcade_v2`) calls for player identity and
progress. A standalone Node server — **NestJS + PostgreSQL (Drizzle)** — verifying Firebase ID tokens from
the same Firebase project the website (`../website`) uses, so a player is one principal across app,
website and backend. Deployed separately from the website. Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

This slice covers **player identity and progress**, plus a **staff-only admin content store** (Phase 5.0:
import and export of question spreadsheets; nothing reaches players yet). Content delivery to players,
purchases, Flight Segment bonuses, leaderboards and the community forum are later slices — see [docs/TASKS.md](docs/TASKS.md).

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
npm run bunny:check           # builds, then probes Bunny Storage (upload/read/delete one object). Needs real credentials: only with the owner's sign-off
```

`.env` points at `demo-airplane-games` and accepts unsigned Firebase Auth Emulator tokens. Start the
emulator from the website repo (`npm run auth:emulator` in `../website`, port 9099) and sign in there to
mint tokens. Emulator tokens are honoured only for exactly `demo-airplane-games`; the production project
can never accept them.

To accept real sign-ins from the cloud project locally (e.g. a Unity build signed in with Firebase), set
`FIREBASE_PROJECT_ID=airplane-games-auth-20261022` and `ALLOW_EMULATOR_TOKENS=false` (in `.env` or the
shell; shell values win). No credentials are needed: the backend only fetches Google's public signing
keys. Players created this way live in your local database only.

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
| `STAFF_EMAILS` | Optional, comma-separated. Emails (trimmed, case-insensitive) allowed to call `/v1/admin/*`, and only with a Firebase-verified token email. Server-only: a client-chosen role never grants access. Unset = nobody is staff. Never logged |
| `BLOB_STORE` | `none` / `memory` / `bunny`. Where staff-uploaded files go. Default `memory` locally and in tests (lost on restart), `none` in production (uploads answer 503 `storage_unavailable`); production refuses `memory` |
| `BUNNY_STORAGE_ZONE` / `BUNNY_STORAGE_PASSWORD` | Required when `BLOB_STORE=bunny`. Zone `aviation-arcade-website` (shared with the website) and its read-write zone password, used exactly as given (not trimmed); a secret, never logged or echoed in config errors. Any `BUNNY_STORAGE_*` set while `BLOB_STORE` is not `bunny` fails at startup |
| `BUNNY_STORAGE_REGION` / `BUNNY_STORAGE_PREFIX` | Default `de` (endpoint `https://de-s3.storage.bunnycdn.com`) and `backend/`. The prefix keeps this backend's objects apart from the website's: lowercase `[a-z0-9_-]` segments, ending in `/`, no leading `/` or `..` |
| `UGS_PROJECT_ID` / `UGS_ENVIRONMENT_ID` / `UGS_SERVICE_ACCOUNT_KEY_ID` / `UGS_SERVICE_ACCOUNT_SECRET` / `UGS_OIDC_PROVIDER` | Optional, **all five or none** (a partial set fails at startup, naming the missing variables only). Turns on the UGS progress mirror and `PUT /v1/me/ugs-link`. The secret is a service account secret, never logged or echoed. `UGS_OIDC_PROVIDER` is the Player Auth OIDC provider id (`oidc-` + up to 15 of `a-z0-9_-`, for example `oidc-firebase`) |
| `UGS_MIRROR_MAX_PER_MIN` | Default 25, 1–33. Mirror writes per minute (token bucket, burst ≤ 10), per instance for now. UGS allows about 33/min sustained per project and IP. Setting it without the other `UGS_*` variables fails at startup |
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
| GET | `/v1/me/progress` | Progress, including `version` (it goes up by one with every change visible in the progress or the UGS copy). 404 `player_not_found` until `PUT /v1/me` |
| PUT | `/v1/me/active-rank` | `{ rank }`. Dial Active Rank down (Pleasure Cruise) or back to Certified. A changed value bumps `version`; the value already in force changes nothing. 403 above Certified |
| PUT | `/v1/me/ugs-link` | `{ ugsToken }`. Proves server-side that a UGS player is this Firebase user, then links it so progress is mirrored to UGS. 201 first link, 200 same/replaced; 400 bad UGS token, 403 no proof, 404 `player_not_found` / `not_found` (mirror off), 409 `ugs_link_conflict`, 503 `auth_unavailable` / `service_unavailable` |
| POST | `/v1/rounds` | `{ module }`. Issues a single-use Round; abandons any other open Round |
| DELETE | `/v1/me` | Account deletion: erases the player and its Rounds. 204 whether or not a player existed |
| POST | `/v1/rounds/:id/result` | `{ finished, errorCount, usedHint, timeRemainingFraction }`. Scores and banks it |
| POST | `/v1/rounds/:id/hint` | No body. Spends the Round's one hint; a repeat is a free 200 replay. 409 `insufficient_hints`. A paid hint always scores as used |
| POST | `/v1/shop/miles-hint-pack` | No body, `Idempotency-Key` header. 5,000 Miles → 10 hints; same key replays. 409 `insufficient_miles` |
| GET | `/v1/admin/me` | Staff only. `{ principal, staff: true }`; 403 `forbidden` for anyone else |
| POST | `/v1/admin/content/:module/imports` | Staff only. Raw `.xlsx` body (≤ 5 MB), optional `X-File-Name`, `?dryRun=true` (plan + field diffs + `planHash`), `?confirm=<planHash>`. 201 imported, 200 plan or `replayed: true`, 422 `import_invalid` (row report, or "dry run first"), 409 `plan_changed` or `import_in_progress`, 503 `storage_unavailable` |
| GET | `/v1/admin/content/:module/items` | Staff only. Items in natural id order, retired ones included (`status`) |
| GET | `/v1/admin/content/:module/export` | Staff only. `.xlsx` in the client's columns plus `Id`, `Version`, `Status` (retired rows included) |

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
`chief-pilot`; modules are the Unity `ModuleRegistry` BackendIds (`atc-match`, `identifier`,
`aircraft-identifier-military`, …) — see `src/rules/`.

## Admin content

The backend Postgres is the source of truth for admin-curated question content (the website admin and Unity
consume it in later slices). Staff = a Firebase-verified token email that is on the server's `STAFF_EMAILS`
list; nothing the client sends can grant it. Admin routes sit behind the normal auth and rate-limit guards and
are exempt from the app's client version gate. Today only `aircraft-identifier-military` has a mapping (the
client's `Military Airplane Identifier v1.xlsx`: 31 rows → `mil-a1`…`mil-a31`, imported as `approved`); any other
module is 404. Importing is all-or-nothing (any row error → 422, nothing written) and a retry is safe: identical
bytes replay while that upload is still the module's latest import (a dry run says `replay: true`); bytes of an older
import are planned again like any file. One import per module at a time (409 `import_in_progress`, retry after 2 s).
The token and the staff rule are checked before the upload body is read. Sheets are limited to 5,000 rows and 50
columns, judged by every cell reference (so a near-empty sheet with one far-off cell is refused, 400). Two kinds
of file (ruled 2026-10-28):

- **Client sheet** (no `Id` column; the client's own spreadsheet) is authoritative. Rows are matched to stored
  items by the trimmed `file` value, so inserting a row mid-sheet keeps every id; unmatched rows get the next free
  id (`mil-a<highest + 1>`); a changed row is an update (version + 1, source `client_sheet`); stored rows the file
  no longer lists are **retired** (status `retired`, kept, version + 1) and come back as `approved` if listed again.
  A missing or repeated `file` value is a row error, into an empty module too (ruled 2026-10-28, so later sheets can
  always match by file name). Anything that updates or retires
  needs `?confirm=<planHash>` from a dry run of the same file (otherwise 422; if data changed since, 409
  `plan_changed`). Creates-only imports need no confirm.
- **Admin export** (has an `Id` column; our export, edited) is versioned: an edit applies to exactly the `Version` it
  was exported at, a stale one is a conflict. It never retires anything and its `Status` column is ignored on import.
  It must keep `file` names non-blank and unique across the module (retired items included), and new ids must
  continue the sequence (at most the highest existing number plus the file's row count).

The original upload is kept forever in Bunny Storage under `backend/imports/<module>/<sha256>.xlsx`. No email is
stored: receipts and the append-only audit log carry the staff principal. Details: ARCHITECTURE.md "Admin content store".

## UGS mirror

Decided 2026-10-28 (user): Unity Gaming Services is the game's first support path and reads progress from UGS first;
this backend stays the authority and the backup. Postgres is the **only writer** of progress and the server computes
every award. UGS holds a **one-way, server-written, player-read-only copy**: the game never writes progress to UGS and
the backend never reads it back. Off unless all `UGS_*` settings are given. Design and facts: ARCHITECTURE.md
"Unity Gaming Services".

- **Link.** After the game signs in to UGS (Firebase as the OIDC provider), it calls `PUT /v1/me/ugs-link` with the UGS
  player token. The server verifies the token (RS256, JWKS, issuer, `exp`/`nbf`, project and environment) and asks UGS
  Player Auth which external identity is on that UGS player; it must be provider `UGS_OIDC_PROVIDER` with the
  Firebase uid. Nothing the client names is trusted. One UGS player links to one backend player (409
  `ugs_link_conflict`, unless UGS no longer lists the other sign-in, in which case the link moves); re-linking the
  same UGS player is a 200 no-op answered without calling UGS; pointing at another UGS player replaces the link and
  queues deletion of the old copy. Link proofs are limited to 5 per hour per player and a server-wide 12/min (burst
  10), because UGS allows only 500 Player Auth admin calls per 30 min per project.
- **What is mirrored.** The Cloud Save **Protected** item `progress`: `{ schemaVersion: 1, version, statusPoints, miles,
  hints, perfectStreak, certifiedRank, activeRank, firstClassUntil, updatedAt }` (see `UgsMirrorProgress` in
  `docs/openapi.yaml`). Field names and values match `GET /v1/me/progress`.
- **How.** Every transaction that changes progress (Round result, hint spend, hint pack, Active Rank change) writes a
  coalesced `ugs_mirror_outbox` row (one per player) in the same transaction, for linked players only. An in-process
  worker claims due rows (`FOR UPDATE SKIP LOCKED`, so several instances are safe), writes them to Cloud Save, and
  deletes the row only if its own claim is still current. Pacing is `UGS_MIRROR_MAX_PER_MIN` (per instance until the
  shared budget row, brief S7); a UGS 429 pauses the worker for `Retry-After`; 401/403 (our credentials) pause it for
  15 min with one error log; 5xx/network failures back off per row (5 s doubling to 15 min); another 4xx is retried
  and a write is dropped after 3 rejections (the next progress change queues it again), while a deletion keeps
  retrying daily. Every tick with due rows logs backlog and lag (never values). `/v1/health/ready` ignores UGS.
- **Ordering.** The game orders UGS copies (and a copy against a server answer) by `version`: it goes up by one with every
  change visible in the copy, an Active Rank change included, and `GET /v1/me/progress` returns the same counter (D-1,
  2026-10-29). `updatedAt` is informational. A UGS re-link does not bump it yet (slice S3).
- **Lag.** Writes are paced to stay inside UGS's admin rate limit (60 req/s and 1,000 per 30 min per project and IP, about
  33/min sustained), so under load the copy can trail the server by minutes. **The game must prefer the server whenever it
  is reachable** and use the UGS copy only as a fallback; the mirror is read-only for the game.
- **Account deletion.** `DELETE /v1/me` removes the link and queued work in its transaction and records the UGS player id
  in `ugs_mirror_deletions`, due only after any in-flight write could have finished (lease + request timeout); the
  worker deletes the Cloud Save item afterwards, best effort and retried. No network call happens inside the player
  lock.
- **Not verified yet** (needs a real UGS project and token): the project/environment claim names in the UGS token
  (`project_id` or `upid`, `envId`), and that the OIDC link's `externalId` equals the Firebase uid. Both are covered by
  `ASSUMPTION` tests against stubs; nothing in the tests contacts UGS.

## Design rules

- **Identity.** The principal is `firebase:<projectId>:<uid>`, taken only from a verified token. Email
  and password and Google are the only accepted providers. No email, display name or Callsign is
  stored here; the Callsign/game-identity contract is a later, separate decision.
- **The server is authoritative for the economy.** The client reports only what happened in a Round.
  Perfect Streak, First Class Pass and Pleasure Cruise are decided server-side, and request bodies are
  strict, so extra fields are rejected.
- **Bank once, never lose a write.** A Round closes and the player is credited in one Postgres
  transaction that first locks the player row (`SELECT … FOR UPDATE`), then the Round. Lock order is
  always player → Round. Every progress change goes through `PlayerBalance.update` (`src/balance/`), which locks the player first and bumps `players.version`.
- **Account deletion** erases only this backend's data. The app deletes the Firebase account itself (the
  backend holds no Firebase admin credentials); until it does, a still-valid token plus `PUT /v1/me`
  creates a fresh player at zero. The delete takes the player lock first, so an in-flight Round result
  either banks before it or gets 404 after.
- **Rules mirror Unity.** `src/rules/` ports `ScoreCalculator`, `FlightRank` and `PilotProgression`. Ranks: Trainee 0, First Officer 10k, Captain 50k,
  Check Airman 100k, Chief Pilot 400k SP.
  Change both together. Test names match the Unity tests.
- **Spec ambiguities are asserted, not buried** (Unity ADR-0004). Each is a test named `ASSUMPTION: …`.

## Known limitations of this slice

Results are client-reported. Server-issued single-use Rounds, one open Round per player, a minimum
Round duration and server-side streak/multiplier logic bound the damage, but a modified client can still
report perfect play. Checking answers server-side arrives with the content-release slice. Token
revocation is not checked: a disabled account's token works until it expires (about an hour).

## Open questions for Josh

Asserted in code and tests until ruled:

1. Speed bonus additive with completion award (spec's worked example implies it).
2. Pleasure Cruise cap applied before the First Class multiplier.
3. Unfinished Round pays nothing and breaks the streak (Unity prototype ruling).
4. Streak Miles pay on the streak carried *into* a Round, even if that Round breaks it (matches Unity).
5. Does a hint break the Perfect Streak? Server says yes (a hinted Round is not a Perfect Completion);
   since 2026-10-27 the Unity app agrees (`9576a63`). Still Josh's ruling.
6. Minimum Round duration is a provisional 3 s; needs per-module/per-rank timer lengths. Source of
   truth is the app's TripProfiles (e.g. ATC Match 15/20/25 s, Call Sign 15/20/20/15/15 s by rank); no
   consolidated table yet.
7. Deleting the account and signing up again re-grants the 5 starter hints (full erasure keeps no
   record of the grant). Acceptable, or keep a minimal tombstone?
8. Trip-completion and 7-day-streak hint grants (Unity `HintBank`) need a server Trip concept; not built.
9. Settled 2026-10-29 after review: identical bytes replay only while they are the module's latest import (a safe
   retry); re-applying an older file's bytes is planned normally, so it conflicts or needs a fresh confirm instead
   of silently doing nothing.
10. Client sheet rows with an empty `file` or `Photographer` import with a warning, not an error. Should a row with
    no photo file be blocked?
