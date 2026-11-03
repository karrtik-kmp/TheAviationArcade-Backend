# Airplane Games — game backend

The server the mobile app (Unity, `C:\Unity\Projects\AviationArcade_v2`) calls for player identity and
progress. A standalone Node server — **NestJS + PostgreSQL (Drizzle)** — verifying Firebase ID tokens from
the same Firebase project the website (`../website`) uses, so a player is one principal across app,
website and backend. Deployed separately from the website. Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

This slice covers **player identity and progress**, plus an **admin-only content store** (Phase 5.0:
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
npm run contracts:write       # builds, then regenerates contracts/*.json (see contracts/README.md); commit the result
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
| `RATE_LIMIT_AUTH_PER_MIN` / `RATE_LIMIT_PUBLIC_PER_MIN` | Defaults 120 / 60 per sliding 60 s window; excess requests are refused only while over the limit (no lockout). Authenticated routes share one budget per principal; public routes are per IP. Health routes exempt. Counters are shared by every instance (see `RATE_LIMIT_STORE`) |
| `RATE_LIMIT_STORE` | `postgres` (default) or `memory`. `postgres` keeps the counters in `rate_limit_hits` (migration 0014), keyed by a hash, so all instances share one limit; `memory` is per process and writes nothing. Failure policy is fail-open: if the shared counter cannot answer (database down, 0014 not applied, a stuck lock), requests are not refused and are counted per instance for 5 s at a time, with a warning logged (repeated every 5 min while it lasts) and `rateLimit: "degraded"` added to the `/v1/health/ready` body, which stays 200. The counter runs on its own small pool (`RATE_LIMIT_POOL_MAX`, 1.5 s connect timeout, which is also the longest wait for a free connection, and 500 ms statement/lock timeouts) so a flood cannot take gameplay's connections. A request that only waited for a busy pool falls back for itself alone; the 5 s degrade is for real database failures |
| `RATE_LIMIT_POOL_MAX` | Default 3 (1–10). Size of the rate limiter's own pool; used only with `RATE_LIMIT_STORE=postgres`. It is in addition to `DB_POOL_MAX` |
| `MIN_CLIENT_BUILD` | Optional, 1–999999999. When set, requests need `X-Client-Version: <build>` at or above it, else 426. Health routes, `DELETE /v1/me` and the website's server (`X-Client: web`) exempt. Unset = gate off (build scheme undecided) |
| `SHUTDOWN_DRAIN_MS` | Default 10000. On SIGTERM/SIGINT: `/v1/health/ready` turns 503, then the server stops accepting, finishes in-flight requests (answering `Connection: close`), closes the pool and exits 0; exit 1 past the deadline; a second signal exits at once |
| `BLOB_STORE` | `none` / `memory` / `bunny`. Where staff-uploaded files go. Default `memory` locally and in tests (lost on restart), `none` in production (uploads answer 503 `storage_unavailable`); production refuses `memory` |
| `BUNNY_STORAGE_ZONE` / `BUNNY_STORAGE_PASSWORD` | Required when `BLOB_STORE=bunny`. Zone `aviation-arcade-website` (shared with the website) and its read-write zone password, used exactly as given (not trimmed); a secret, never logged or echoed in config errors. Any `BUNNY_STORAGE_*` set while `BLOB_STORE` is not `bunny` fails at startup |
| `BUNNY_STORAGE_REGION` / `BUNNY_STORAGE_PREFIX` | Default `de` (endpoint `https://de-s3.storage.bunnycdn.com`) and `backend/`. The prefix keeps this backend's objects apart from the website's: lowercase `[a-z0-9_-]` segments, ending in `/`, no leading `/` or `..` |
| `UGS_PROJECT_ID` / `UGS_ENVIRONMENT_ID` / `UGS_SERVICE_ACCOUNT_KEY_ID` / `UGS_SERVICE_ACCOUNT_SECRET` / `UGS_OIDC_PROVIDER` | Optional, **all five or none** (a partial set fails at startup, naming the missing variables only). Refused at startup with a `demo-` `FIREBASE_PROJECT_ID` (except `APP_ENV=test`, whose values are fake), so a demo player can never write to real UGS. Turns on the UGS progress mirror and `PUT /v1/me/ugs-link`. The secret is a service account secret, never logged or echoed. `UGS_OIDC_PROVIDER` is the Player Auth OIDC provider id (`oidc-` + up to 15 of `a-z0-9_-`, for example `oidc-firebase`) |
| `UGS_MIRROR_MAX_PER_MIN` | Default 25, 1–33. Cloud Save calls per minute (token bucket, burst ≤ 10), **shared by all instances** through one Postgres row (`ugs_budget`), so run every instance with the same value. UGS allows about 33/min sustained per project and IP. Setting it without the other `UGS_*` variables fails at startup |
| `UGS_MIRROR_MIN_INTERVAL_SEC` | Default 300, 0–3600; 0 turns the delay off. The least time between two copy writes for one player (C3): Rounds inside the interval coalesce into one write of the latest version. The first write after a link or re-link is not delayed (a Round that was already waiting when the player re-linked becomes due at once), and deletions are never delayed. Optional like `UGS_MIRROR_MAX_PER_MIN`, so it is not one of the five required variables, but setting it without them also fails at startup |
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

API 0.7.0: Progress and the UGS copy (`schemaVersion` 3) carry a required `evaluatedAt`, the DATABASE clock at the
instant the view was built (the same instant judges lazy Trip expiry). The game orders copies by `(version,
evaluatedAt)`: `version` orders stored changes, `evaluatedAt` orders time-derived changes at one version (user ruling
2026-11-02, D-1 amended). `updatedAt` is not an evaluation time. Trip opens reject reuse of a key unless module,
localDate, utcOffsetMinutes and contentVersion all match (422 `idempotency_key_reused`): persist the original body with
the key and retry both unchanged, including across midnight.

The contract is [docs/openapi.yaml](docs/openapi.yaml), kept in step with the code by a parity test.
The table lists only what is built. Flight Segments (Unity Trips: open, abandon, Rounds inside a segment) are built
(slice T2), and so is completing one (slice T3, API 0.5.0: outcome, Field Awards, Clipper Cards, the Trip hint). The rest
and so are the content manifest and its immutable documents (slice T4, API 0.9.0) and the Pilot Logbook (slice T5, API 0.10.0), and the staff edit-and-publish routes for the documents (slice T6, API 0.11.0).
Nothing is `x-planned` any more; the design, with a section per slice as built, is
[docs/design/trips-awards-logbook.md](docs/design/trips-awards-logbook.md).

> **Breaking change for the Unity app (API 0.4.0, slice T2, 2026-10-29).** The Round routes changed shape:
> `POST /v1/rounds` takes `{ tripId }` instead of `{ module }`, and `POST /v1/rounds/:id/result` requires the Flight
> facts `aircraftKey`, `answerMs` and `attempts`. Both answer 400 `invalid_request` to the old bodies. To play a Trip
> the app now: (1) `POST /v1/trips` with a fresh `Idempotency-Key` and `{ module, flightCount: 10, localDate,
> utcOffsetMinutes, contentVersion }` (module and rank are fixed for the whole segment, rank is the player's Active
> Rank); (2) `POST /v1/rounds { tripId }` per Flight; (3) `POST /v1/rounds/:id/result` with the old four fields plus
> `aircraftKey` (Identifier: the aircraft family, e.g. `787`, which must be a seeded Card family; Military: the
> question id `mil-aN`; every other module: `null`), `answerMs` and `attempts`; (4) after the tenth banked Round,
> `POST /v1/trips/:id/complete` (API 0.5.0, slice T3: a new route plus one behaviour change). Opening the next segment while a
> full one is still open completes the full one first, so `POST /v1/trips` no longer returns 409 `trip_full` (0.4.0 did); Unity must
> not treat that code as expected there any more. Vocabulary: a backend Round is a
> Unity Flight, a Flight Segment is a Unity Trip.
All endpoints except health need `Authorization: Bearer <Firebase ID token>`. Errors are
`{ "error": { "code", "message", "requestId" } }`; every response carries `X-Request-Id`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/health` | Liveness, public. No database, not rate limited |
| GET | `/v1/health/ready` | Readiness, public, not rate limited: `SELECT 1` within 2 s (cached ~1 s), else (or while shutting down) 503 `service_unavailable` |
| PUT | `/v1/me` | Sign-in handshake. Creates the player on first call (201), else 200. Returns progress |
| GET | `/v1/me/progress` | Progress, including `version` (it orders stored changes; `evaluatedAt`, the database clock, orders the rest at equal versions). 404 `player_not_found` until `PUT /v1/me` |
| PUT | `/v1/me/active-rank` | `{ rank }`. Dial Active Rank down (Pleasure Cruise) or back to Certified. A changed value bumps `version`; the value already in force changes nothing. 403 above Certified |
| PUT | `/v1/me/ugs-link` | `{ ugsToken }`. Proves server-side that a UGS player is this Firebase user, then links it so progress is mirrored to UGS. 201 first link, 200 same/replaced; 400 bad UGS token, 403 no proof, 404 `player_not_found` / `not_found` (mirror off), 409 `ugs_link_conflict`, 503 `auth_unavailable` / `service_unavailable` |
| POST | `/v1/trips` | `{ module, flightCount: 10, localDate, utcOffsetMinutes, contentVersion }` and a required `Idempotency-Key`. Opens a Flight Segment at Active Rank (abandons the player's open one; its Perfect Streak starts at 0). 201 opened, 200 replay of a key already used with the same module, localDate, utcOffsetMinutes and contentVersion, 422 `local_date_mismatch` (beyond 15 minutes of server time plus the offset), 422 `idempotency_key_reused` (the key opened a segment with a different module, localDate, utcOffsetMinutes or contentVersion). A full open segment is completed first (same transaction), not abandoned |
| POST | `/v1/trips/:id/complete` | No body, after the 10th banked Round. In one player-locked transaction: the outcome, the Award counters (Go Around, Red-Eye ...), Clipper Cards, all 28 Field Awards, the Trip hint (`trip_grant`, +1 on every 4th completed segment), Perfect Streak back to 0, and the UGS copy republished at once. Returns `{ trip, fieldAwards, clipperCards, hintGrants, replayed, progress }`. Idempotent: a repeat returns the identical lists with `replayed: true` and pays nothing twice. 404 `trip_not_found`, 409 `trip_incomplete` (fewer than 10 banked), 410 `trip_expired` (partial and past expiry) / `trip_closed` (abandoned) |
| GET | `/v1/me/logbook` | The Pilot Logbook (slice T5, API 0.10.0): `recentTrips` (the 20 newest completed Trips), `daily`, `lifetime`, `counters`, every Clipper Card, and all 28 Field Awards against the catalog in force. One read-only REPEATABLE READ snapshot: no lock, no write, nothing bumped. `Logbook.version` is the Logbook's own counter (`players.logbook_version`), **not** `Progress.version`; it rises when a Round is banked or a Trip is completed (including the lazy completion inside `POST /v1/trips`), and not on an abandon, a replay, a hint, a rank change or a refusal. Strong `ETag` (`lb-` + 32 hex) over the player, the counter and the Field Award and aircraft-tag versions in force, so a catalog publish changes it with no player write; `If-None-Match` (exact, weak, list or `*`) gives 304. `Cache-Control: private, no-cache` (an exception to the `/v1` no-store). `earned` is the stored fact, never `current >= target`. 404 `player_not_found` until `PUT /v1/me`; 503 `service_unavailable` while the content documents are unseeded. Size: 20 Trips, 28 awards, one record per Card held (about 8 KB today) |
| GET | `/v1/content/manifest` | Any signed-in player. Unity `ManifestWire`/`ModuleWire` (`version`, `generatedAtUtc`, `modules[] { id, enabled: true, contentVersion: null, assetBundleUrl: null }`) plus `documents[] { name, format, version, sha256, byteSize, url }`: the highest version of each document. `version` is a stable hash and the strong `ETag`; `If-None-Match` (exact, weak, list or `*`) gives 304. `Cache-Control: no-cache` (an exception to the `/v1` no-store). `generatedAtUtc` is the newest document `createdAt`, not the request time |
| GET | `/v1/content/documents/:name/:version` | Any signed-in player. `name` is `field-awards`, `clipper-cards` or `aircraft-tags`. The document's canonical JSON bytes (keys sorted, no whitespace, UTF-8, integers only; their SHA-256 is the manifest's `sha256` and the `ETag`). `Cache-Control: private, max-age=31536000, immutable`; 304 for the matching `If-None-Match`. 404 `not_found` for an unknown name or version (also a malformed version). 500 only for a corrupted row (never served) |
| POST | `/v1/trips/:id/abandon` | No body. Closes the segment and its open Round; 200, `replayed: true` when it was already closed or expired. 404 `trip_not_found`, 409 `trip_full`, 410 `trip_closed` |
| POST | `/v1/rounds` | `{ tripId }`. Issues the segment's next single-use Round (flight number banked + 1; a re-issue keeps the number); abandons any other open Round. 404 `trip_not_found`, 409 `trip_full`, 410 `trip_expired` / `trip_closed` |
| DELETE | `/v1/me` | Account deletion: erases the player and its Rounds. 204 whether or not a player existed |
| POST | `/v1/rounds/:id/result` | `{ finished, errorCount, usedHint, timeRemainingFraction, aircraftKey, answerMs, attempts }`. Scores and banks it from the segment's own Perfect Streak; moves the day streak (+1 hint on every 7th consecutive local day, `hintGrants`). Flight facts that break a module rule are 400 and bank nothing. An `Idempotency-Key` header is accepted and ignored (the Round id is the key) |
| POST | `/v1/rounds/:id/hint` | No body. Spends the Round's one hint; a repeat is a free 200 replay. 409 `insufficient_hints`. A paid hint always scores as used |
| POST | `/v1/shop/miles-hint-pack` | No body, `Idempotency-Key` header. 5,000 Miles → 10 hints; same key replays. 409 `insufficient_miles` |
| GET | `/v1/admin/me` | Admin only. `{ principal, staff: true, roles }` (`roles` = the caller's ACTIVE roles); 403 `forbidden` for anyone else, a photographer included |
| POST | `/v1/admin/content/:module/imports` | Admin only. Raw `.xlsx` body (≤ 5 MB), optional `X-File-Name`, `?dryRun=true` (plan + field diffs + `planHash`), `?confirm=<planHash>`. 201 imported, 200 plan or `replayed: true`, 422 `import_invalid` (row report, or "dry run first"), 409 `plan_changed` or `import_in_progress`, 503 `storage_unavailable` |
| POST | `/v1/admin/content/:module/trip-coverage` | Admin only. Optional JSON `{ itemIds?: string[] }` (≤ 2000, repeats count once). 200 `{ module, policy, flightsPerTrip, ranks: [{ rank, dealable }] }`: Flights a Trip would hold per rank from the module's approved items (blank photo not dealable). 404 for a module with no mapping or no deal policy, 422 `unknown_item_ids`, 400 for a bad body |
| GET | `/v1/admin/content/documents` | Admin only (T6). `{ documents: [...] }`, one per document name: `publishedVersion` (the version players are served), `draftVersion` (0 = no draft), `changed`, `edits`, `changes` |
| GET | `/v1/admin/content/documents/:name/draft` | Admin only. The draft plus `body`, the document a publish would write now (a preview, not served). 404 for an unknown name |
| PATCH | `/v1/admin/content/documents/:name/draft` | Admin only. `{ draftVersion, awards \| names \| entries }` per document: Field Award `title`/`criteria`/`target`/`hidden`, Card `name`, a Card's tag list. Never an id or metric (400). Stale `draftVersion` = 409 `version_conflict`; an unknown Card = 422 `content_invalid` |
| POST | `/v1/admin/content/documents/:name/draft/discard` | Admin only. `{ draftVersion }`. 200, clears the draft (also the way out of a stored draft that no longer validates) |
| POST | `/v1/admin/content/documents/:name/publish` | Admin only. `{ draftVersion, note? }`. 201 `{ name, version, previousVersion, sha256, byteSize, draftVersion, changeCount, manifestVersion }`. One transaction: next immutable version, one `content_publish` audit row, draft reset. 409 `version_conflict` / `nothing_to_publish`, 422 `content_invalid`; nothing is written on a refusal |
| GET | `/v1/admin/content/:module/items` | Admin only. Items in natural id order, retired ones included (`status`) |
| GET | `/v1/admin/content/:module/export` | Admin only. `.xlsx` in the client's columns plus `Id`, `Version`, `Status` (retired rows included) |

Result status codes: 200 banked (or `replayed: true` for a Round already banked — safe to retry),
404 not this player's Round, 410 expired or abandoned (`round_expired`, `round_closed`, or `trip_expired` when the segment ran out first), 400 bad Flight facts, 429 submitted too soon after issue (retry after
`Retry-After`), 503 `auth_unavailable` when Google's signing keys cannot be fetched, 503
`service_unavailable` when the database is unreachable or times out (both with `Retry-After`).
Unknown routes are 404 `not_found`. Bodies are JSON only, at most 16 KB: malformed or extra-field
bodies are 400 `invalid_request`, oversized 413, wrong charset/encoding 415 (same code). 401s carry
`WWW-Authenticate: Bearer`; `/v1` responses other than health are `Cache-Control: no-store`.

Any route can also return 429 `rate_limited` (with `Retry-After`; distinct from `round_too_fast`), and,
when `MIN_CLIENT_BUILD` is set, 426 `client_update_required` (checked before authentication; health
routes and `DELETE /v1/me` exempt, so an outdated app can still delete its account). `POST /v1/rounds`
and `POST /v1/trips` return 201 (the trip route answers 200 for an `Idempotency-Key` it already used).

Ranks and module IDs on the wire are kebab-case: `trainee`, `first-officer`, `captain`, `check-airman`,
`chief-pilot`; modules are the Unity `ModuleRegistry` BackendIds (`atc-match`, `identifier`,
`aircraft-identifier-military`, …) — see `src/rules/`.

## Admin content

The backend Postgres is the source of truth for admin-curated question content (the website admin and Unity
consume it in later slices). Admin routes need the `admin` role: an ACTIVE row for the verified principal in the
`account_roles` table and a Firebase-verified token email ([ADR-0002](docs/adr/ADR-0002-role-based-access.md)). Roles are
read on every request, so a revoke takes effect on the next call; no environment list (the retired `STAFF_EMAILS`), email,
header or body field can grant one. The first admin comes from `npm run roles:grant` (see "First admin"). Admin routes sit behind the normal auth and rate-limit guards and
are exempt from the app's client version gate. Today only `aircraft-identifier-military` has a mapping (the
client's `Military Airplane Identifier v1.xlsx`: 31 rows → `mil-a1`…`mil-a31`, imported as `approved`); any other
module is 404. Importing is all-or-nothing (any row error → 422, nothing written) and a retry is safe: identical
bytes replay while that upload is still the module's latest import (a dry run says `replay: true`); bytes of an older
import are planned again like any file. One import per module at a time (409 `import_in_progress`, retry after 2 s).
The token and the admin role are checked before the upload body is read (the request is rate limited first, per principal, so refusals count). Sheets are limited to 5,000 rows and 50
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
stored: receipts and the append-only audit log carry the admin's principal. Details: ARCHITECTURE.md "Admin content store".

### First admin

The first admin (and recovery when no active admin is left) is granted by the operator, not the API:

```
npm run roles:grant -- <firebase-uid> [--email <address>] --yes
```

It builds, then grants `admin` to `firebase:<FIREBASE_PROJECT_ID>:<uid>` with the same role store as the API (role lock,
revision bump, `role_grant` audit row, actor `operator:<os user>`). It prints the target database host and name (never the
password) and refuses without `--yes`. It accepts only `admin`, refuses when ANY active admin exists (checked in the same
locked transaction as the grant), refuses a full principal of another project or a bad uid, and refuses a `demo-` project when
`APP_ENV=production`. A `revoked` admin row becomes `active` again. Settings come from the shell or `.env` and are checked by the server's own config loader, so the TLS rules
(`DATABASE_SSL`, `DATABASE_CA_CERT`, no ssl options in `DATABASE_URL`) and every other server setting are enforced as for the API:
`DATABASE_URL`, `FIREBASE_PROJECT_ID`, `APP_ENV`. Exit codes: 0 granted, 1 unexpected
failure, 2 refused by arguments or settings, 3 refused by the database state. Every later admin is granted through
`POST /v1/admin/accounts/{principal}/roles/admin/grant`.

`--email` (or `--email=<address>`) stores a typed, unverified, display-only email on the admin row, validated by the same
helper as the API (trimmed, lowercased, one `@`, 3-320 characters); a bad value exits 2 with nothing written. An admin can
later correct it with `PUT /v1/admin/accounts/{principal}/roles/admin/email`. No email is ever written to the audit log.
`POST .../roles/photographer/block` and `.../unblock` keep an account out of (or back into) the photographer request flow;
an active admin cannot be blocked, and admin cannot be granted (API or this command) to a blocked account (409).

## Content documents and the manifest (slice T4)

Three published, versioned data documents live in `content_documents` (rows are immutable; a change is a new version for that
name): `field-awards` (the 28 Field Awards on the Unity code ids, the client's sheet text verbatim), `clipper-cards` and
`aircraft-tags`. `GET /v1/content/manifest` lists the highest version of each; the app pulls the ones that changed.
`catalogInForce(tx)` (what Trip completion judges against) reads the highest *valid* `field-awards` and `aircraft-tags`
versions (the manifest lists the same selection); a bad newest row is skipped with an error log once, verdicts are memoised per (name, version, sha256), and the recorded `catalog_version` is the field-awards version applied. With no valid document yet, completing a Trip answers a retryable 503 `service_unavailable`.
- **Seed.** Version 1 is generated, never typed: `field-awards` and `aircraft-tags` from the code constants in `src/rules`,
  `clipper-cards` from the commercial families plus the approved Military items. It runs at every start (idempotent, one
  transaction under an advisory lock, a name that already has any row is never touched) and again after each successful content
  import. `clipper-cards` v1 is sealed only once Military items exist, so a fresh database lists it after the first import and a
  database that already has content lists it at the first start. After v1, content changes reach the app only as a new
  version (the T6 publish, below). A database that is down at start does not stop the server; the seed retries in the background.
- **Bytes.** The served bytes are the canonical JSON of the stored `body` (`src/content/documents/canonical.ts`: UTF-8, keys
  sorted at every depth, no whitespace or newline, integers only), because `jsonb` keeps neither key order nor whitespace.
  `sha256` / `byte_size` are their digest and length, re-checked at every read; a mismatch is a 500, never a response.
- **Immutable.** Only `document-store.ts` writes the table (`test/content-documents.test.ts` scans for it) and a trigger
  refuses UPDATE and DELETE. A test that needs to drop a row it inserted disables the trigger in its own transaction.

## Editing and publishing the documents (slice T6)

Staff edit the draft of a document and publish it; players see nothing until the publish. A draft is a **mutable overlay** on the
version in force (`content_drafts`, one row per document name, created by the first edit), not a copy: Field Award fields,
Card names or a Card's tag list. Published versions stay immutable. Every edit, discard and publish of one name runs under a
per-name advisory lock, and `draftVersion` is the editors' version check: a stale one is 409 `version_conflict` and nothing
changes, so an edit never overwrites another editor's and two publishes can never write one version twice or lose an edit. A publish
validates the document with the T4 validators (28 ids once, each award's own metric, integer targets of at least 1), refuses an
unchanged draft (409 `nothing_to_publish`), then inserts version `highest + 1` through `document-store.ts`, writes exactly one
`content_publish` audit row (actor = the verified staff principal, the changes, the digest, the note) and resets the draft. The manifest
`version`, `catalogInForce`, later completions' `catalog_version` and the Logbook `ETag` move with it, with no player write; earned
awards never un-earn (U7) and a completion made under an older version replays unchanged.

`clipper-cards` is rebuilt from the approved Military content as it is at publish time, so publishing it is how a v1 sealed from a
small or trial set catches up (and how Cards of newly approved or retired items appear or go); a staff-edited Card name is kept. Not
built: Remote Config, and re-importing a later Field Awards sheet through plan, confirm and apply (follow-ups in `docs/TASKS.md`).

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
  same UGS player is a 200 no-op answered without calling UGS; pointing at another UGS player replaces the link, bumps `version` once and
  queues deletion of the old copy. Link proofs are limited to 5 per hour per player (counted in memory, per instance) and
  to 12/min across all instances (burst 10, its own `ugs_budget` row), because UGS allows only 500 Player Auth admin calls
  per 30 min per project.
- **What is mirrored.** The Cloud Save **Protected** item `progress`: `{ schemaVersion: 3, uid, version, evaluatedAt, statusPoints,
  miles, hints, perfectStreak, certifiedRank, activeRank, firstClassUntil, updatedAt }` (see `UgsMirrorProgress` in
  `docs/openapi.yaml`). Field names and values match `GET /v1/me/progress`. `uid` is the owner's Firebase uid (user
  ruling 2026-10-29): after a link moves or an account is deleted and re-linked, the item can briefly hold the previous
  owner's copy, so the game uses a copy only when `uid` matches the signed-in user.
- **How.** Every transaction that changes progress (Round result, hint spend, hint pack, Active Rank change) writes a
  coalesced `ugs_mirror_outbox` row (one per player) in the same transaction, for linked players only. An in-process
  worker claims due rows (`FOR UPDATE SKIP LOCKED`, so several instances are safe), writes them to Cloud Save, and
  deletes the row only if its own claim is still current. Pacing is `UGS_MIRROR_MAX_PER_MIN`, one budget shared by every
  instance (D-4): a tick with due rows reserves as many tokens as there are due rows (at most 20) before it claims anything and refunds the ones it did not use (an idle tick does not touch the budget); refill and pause time use the database clock, so one instance's wrong clock cannot freeze or inflate the shared budget; a UGS 429 pauses
  **all** instances for `Retry-After`; 401/403 (our credentials) pause all of them for 15 min with one error log. **The pause is stored in the shared row, so it survives restarts of every instance.** After fixing the credentials, clear it instead of waiting out the 15 minutes: `UPDATE ugs_budget SET paused_until = NULL WHERE name = 'cloud_save_admin'` (the worker picks it up on its next tick); 5xx/network failures back off per row (5 s doubling to 15 min); another 4xx is retried
  and a write is dropped after 3 rejections (the next progress change queues it again), while a deletion keeps
  retrying daily. Every tick with due rows logs backlog and lag (never values). `/v1/health/ready` ignores UGS.
- **Ordering.** The game orders UGS copies (and a copy against a server answer) by `(version, evaluatedAt)` (user ruling
  2026-11-02, D-1 amended). `version` goes up for stored progress changes, an Active Rank change included, and
  `GET /v1/me/progress` returns the same counter (D-1, 2026-10-29). `evaluatedAt` is the database clock at the instant the
  copy was built (the worker reads the database clock inside `withLiveStreak` for each row, not the tick's time; the worker test proves the stamp is database time, the per-row call is by code); it orders changes that need no write, such as
  lazy Trip expiry. `updatedAt` is informational. A UGS re-link to a different UGS player and a stale-holder link move bump it (D-1); a first link enqueues at the current
  version without bumping it, and re-linking the same UGS player changes nothing.
- **Lag.** Writes are paced to stay inside UGS's admin rate limit (60 req/s and 1,000 per 30 min per project and IP, about
  33/min sustained, shared by all instances), and a player's copy is written at most once per
  `UGS_MIRROR_MIN_INTERVAL_SEC` (default 5 minutes; C3), so the copy can trail the server by that interval plus any backlog
  (the first write after a link or re-link is immediate, also for a Round that was waiting at that moment; a write at Trip end will skip the wait when server Trips exist). **The game must prefer the server whenever it
  is reachable** and use the UGS copy only as a fallback; the mirror is read-only for the game.
- **Account deletion.** `DELETE /v1/me` removes the link and queued work in its transaction and records the UGS player id
  in `ugs_mirror_deletions`, due only after any in-flight write could have finished (lease + request timeout); the
  worker deletes the Cloud Save item afterwards, best effort and retried. No network call happens inside the player
  lock.
- **Verified on `development`, 2026-11-02** (`npm run ugs:check -- --live`, one test player, token exchanged by the
  script): the token claims, `externalId` = Firebase uid, the link, and the Cloud Save copy after the link and after a
  banked Round. **Not verified:** a sign-in from the game, `production`, the Cloud Save delete, load or rate limits.
  Nothing in the tests contacts UGS: `vitest.e2e.config.ts` drops any `UGS_*` value read from `.env`.

## Design rules

- **Identity.** The principal is `firebase:<projectId>:<uid>`, taken only from a verified token. Email
  and password and Google are the only accepted providers. No email, display name or Callsign is
  stored here; the Callsign/game-identity contract is a later, separate decision.
- **The server is authoritative for the economy.** The client reports only what happened in a Round.
  Perfect Streak, First Class Pass and Pleasure Cruise are decided server-side, and request bodies are
  strict, so extra fields are rejected.
- **Bank once, never lose a write.** A Round closes and the player is credited in one Postgres
  transaction that first locks the player row (`SELECT … FOR UPDATE`), then its Flight Segment, then the Round. Lock order is
  always player → segment → Round. Every progress change goes through `PlayerBalance.update` (`src/balance/`), which locks the player first and bumps `players.version`.
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
8. The 7-day-streak hint grant (Unity `HintBank`) is built (T2, `day_streak_grant`), and so is the Trip-completion grant (+1 per 4 completed Trips, `trip_grant`, T3).
9. Settled 2026-10-29 after review: identical bytes replay only while they are the module's latest import (a safe
   retry); re-applying an older file's bytes is planned normally, so it conflicts or needs a fresh confirm instead
   of silently doing nothing.
10. Client sheet rows with an empty `file` or `Photographer` import with a warning, not an error. Should a row with
    no photo file be blocked?
