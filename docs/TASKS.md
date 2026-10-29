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
| 3.1 | Miles ledger | Done (local) | `miles_ledger`, UNIQUE(player, kind, ref); Round awards and hint-pack debits written as entries; backfilled from completed Rounds (migration 0003) |
| 3.2 | Spending (hints, skips) | Partial (local) | Server hint bank: 5 starter hints, `POST /v1/rounds/:id/hint` (1 per Round, idempotent), `POST /v1/shop/miles-hint-pack` 5,000 Miles → 10 hints (CF-53), `hint_ledger`. Numbers from Unity `HintBank`/`MilesHintPack`. Not built: Trip/7-day hint grants (need a server Trip concept), skips (no price anywhere) |
| 3.3 | Flight Segment set bonuses | Blocked | Josh: per Module? does a hint break Perfect Manifest? |
| 3.4 | Rule rulings | Blocked | Josh: per-Module/rank minimum Round time (the app still owes the timer table; 3 s floor stays). Hint vs streak: the app now agrees with the server (a hinted Round is Standard and breaks the streak, Unity `9576a63`); the ruling itself is still Josh's |
| 3.5 | Field Awards | Not started | Client source is now `../docs/Field Awards #1.xlsx` (2026-10-28, 28 rows; supersedes `Draft_for_FieldAwards v2.xlsx`: Go Around is redefined as a full green Trip after a non-full one, Quad-Engine Royalty lists military types). Awards pay no Miles or Status Points. Use exactly the client's rows; Unity owns the catalog |

Deploy note for migration 0003: apply it with no old-image instance serving (stop the world). An old
image would create players without starter hints and bank Rounds without ledger rows, and nothing would
reconcile them. Irrelevant while local-only; matters for the first hosted deploy.

### Phase 4 — Purchases

Needs App Store Connect / Play Console access and credentials. First Class Pass subscriptions,
consumables, Status Point boosts (refund reverses only an unused boost; confirm "used"), Apple ASSN v2 and
Google RTDN. Design in ARCHITECTURE.md.

### Phase 5 — Content

| # | Job | State | Notes |
|---|---|---|---|
| 5.0 | Admin content store foundation | Done (local, uncommitted) | Staff-only API (`STAFF_EMAILS` + verified email): import xlsx → `content_items`, list, export, `GET /v1/admin/me`. Military mapping from the client's sheet (31 rows → `mil-a1`…`mil-a31`, approved, source `client_sheet`). Idempotent by file sha256, all-or-nothing, unzip-bomb guard. Import semantics ruled 2026-10-28 (Q1-Q9 below): client sheets are authoritative with stable ids (matched by `file`), retire missing rows, field diffs and a `planHash` confirm before any overwrite/retire (409 `plan_changed`); admin exports keep versioned edits. `BlobStore` (Bunny S3 with SigV4 / memory / none), migrations 0004 (`content_imports`, `content_items`, `admin_audit`) and 0005 (`retired` status and count). Real Bunny never contacted |
| 5.2+ | Follow-ups (not started) | — | Releases and versioned packages with rollback; player content delivery and Rounds tied to a release; server-side answer checks (closes the client-reported-results gap); photo upload/serving; retire and edit-in-place endpoints; importers for the other seven modules; website admin integration; first `bunny:check` against the real zone (needs sign-off and the zone password) |

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
- 2026-10-28 (user): Backend Postgres is the source of truth for admin content; a staff-only admin API
  (import xlsx → items, export xlsx, list). Website admin and Unity consume it later.
- 2026-10-28 (user): staff = token `email_verified === true` AND lowercased `email` in server-only
  `STAFF_EMAILS` (the website's rule). Never a client-supplied role.
- 2026-10-28 (user): Bunny Storage shares the website zone `aviation-arcade-website` (Frankfurt, `de`) under key
  prefix `backend/`. Built against an in-memory fake; the real zone is probed only with explicit sign-off.
- 2026-10-28 (user): client-sheet rows import as `approved` (source `client_sheet`, file sha256 recorded). No
  player-facing content route, no release in this slice.
- 2026-10-28 (user), 5.0 import semantics. A **client sheet** is an upload without an `Id` column; an **admin
  export** has one.
  - Q1 stable ids: into an empty module ids are row order (`mil-a1`…); into a non-empty one rows match stored items by
    the trimmed `file` value (exact), unmatched rows get `mil-a<max suffix + 1>` in sheet order; a missing or
    repeated file name is a row error (never guessed), into an EMPTY module too (user ruling 2026-10-28, so later
    sheets can always match by file name). Re-importing the original sheet is all `unchanged`.
  - Q2 the client sheet is authoritative: a matched row with different data is an update (version + 1, source
    `client_sheet`); the dry run shows `{ field, from, to }` per updated row.
  - Q3 rows missing from a client sheet are retired (`status = retired`, version + 1, listed in the plan); a retired
    item that reappears returns to `approved`; admin-export imports never retire. Items list/export carry status
    (export has a `Status` column, ignored on import). Migration 0005 (0004 left untouched).
  - Confirm before overwrite: dry run returns `planHash`; a client-sheet apply that updates or retires needs
    `?confirm=<planHash>` (missing 422 `import_invalid`; changed data 409 new code `plan_changed`). Creates-only and
    admin-export applies need none.
  - Q4 gaps (empty Photographer/file) import as `approved` with warnings. Q5 the website reaches the backend
    server-to-server through its Worker: no CORS. Q6 Military is the only importer. Q7 original uploads are kept
    forever in Bunny. Q8 identical bytes replay first. Q9 source is `client_sheet` for client-sheet creates/updates,
    `admin` for admin-export ones.
- 2026-10-27: backend Postgres owns all progress; UGS keeps no copy (no Cloud Save mirror, no UGS
  Economy). Firebase-OIDC link and webhooks only if a UGS service is adopted. See ARCHITECTURE.md.
- 2026-10-28 (user): a client-sheet import into an EMPTY module must also have unique, non-blank trimmed `file` names
  (row error otherwise), same as the non-empty case, so later sheets can always match by file name. The real client
  sheet (31 rows) still imports 31 items.
- 2026-10-28: an admin edit of a retired item leaves it retired (only a client sheet listing it again returns it to
  `approved`).

## Open questions for Josh

See README "Open questions". Also: Apple's App Store guidelines generally require Sign in with Apple
when Google sign-in is offered; the project rule currently allows only email/password and Google.

## Verification log

- 2026-10-29 (5.0 independent review + fixes): Opus review (read-only) reproduced a 2.7 KB xlsx (one cell at
  `XFD1048576`) OOM-killing node, because `read-excel-file` densifies sparse sheets past the zip-bomb guard. Fixed with a
  cell-reference scan before parsing (tests at XFD1048576 / ZZ100000, < 3 s, < 100 MB). Also fixed: admin exports could
  blank or duplicate natural keys; 5 MB body read before auth; a dry run that the apply silently replayed (replay now
  only for the module's latest import); Bunny refusals as 500; ids past the `mil-aNNNNNN` range; imports parking pooled
  connections on the advisory lock (now try-lock, 409 `import_in_progress`). My run after both fix rounds: typecheck
  clean, `npm test` 211/211, `npm run db:migrate` applied 0007, `npm run test:e2e` 201/201, `npm run build` OK. Local only;
  UGS and Bunny never contacted.

- 2026-10-28 (5.0 import semantics follow-up, Q1-Q9 + confirm-before-overwrite, implementer's run, not yet independently
  reviewed): from PowerShell at `H:\Work\TheAviationArcade\Backend`: `npm run typecheck` clean, `npm test` 167/167
  (11 files), `npm run db:migrate` applied 0005 to local Postgres, `npm run test:e2e` 152/152 (4 files),
  `npm run build` OK. New coverage: first import, re-import unchanged, row inserted mid-sheet keeps ids, changed answer
  -> diff + confirm required, stale/foreign confirm -> 409 `plan_changed`, retire + reappear, admin export never retires
  and ignores `Status`, duplicate/missing file name errors, replay before confirm. The real client file re-planned
  against its own first import is 31 unchanged (unit test, skipped if `../docs` is absent). Not verified: real Bunny,
  a real staff token, behaviour on a database that already holds production-size content.

- 2026-10-28 (5.0 Admin content store, implementer's run, before independent review): `npm run typecheck`
  clean, `npm test` 149/149 (11 files), `npm run db:migrate` applied 0004 to local Postgres, `npm run test:e2e`
  140/140 (4 files), `npm run build` OK. Real client file `../docs/Military Airplane Identifier v1.xlsx` parses
  to 31 items (`mil-a1`..`mil-a31`, `mil-a5` = Boeing C-17), rows 35-36 skipped with a warning. A 60 MB-inflating
  zip fixture is refused in well under 5 s. Library pins: `read-excel-file` 9.3.12 (not 9.3.10: its CHANGELOG
  lists 9.3.12 as a fix for a crash on valid xlsx files whose `<sheetData/>` is not near the start of the sheet
  XML; 9.3.11 was an incorrectly published release; 9.3.13 is 1 day old), `write-excel-file` 4.1.1,
  `aws4fetch` 1.0.20, `fflate` 0.8.3 (what `read-excel-file` resolves), `express` 5.2.1 (what Nest resolves;
  made a direct pin for the route-scoped raw parser). Not verified: any request to the real Bunny zone (never
  contacted; `npm run bunny:check` not run), a real signed-in staff token (emulator tokens only), Excel/LibreOffice
  opening the exported file by eye, a populated production-size sheet (5,000 rows). Local only.

- 2026-10-28 (3.1 Miles ledger + hint bank): implemented by a Sonnet subagent; independent Opus review found
  no double debit/credit, race or leak (lock order player→round everywhere; replay checked before funds;
  keys scoped per player; backfill verified on a populated scratch DB: miles 300/300, hints 5/5). Fixed from
  the review: the hint route accepted any body (now strict, 400 in the contract); an openapi test set Miles
  without a ledger row. Logged: stop-the-world deploy for 0003, starter re-grant after deletion (ASSUMPTION
  test, question 7), 409-then-reuse of a key buys later (documented: new key per attempt). My run:
  typecheck clean, `npm test` 94/94, `npm run db:migrate` applied 0003, `npm run test:e2e` 108/108,
  `npm run build` OK. Vitest must run from an uppercase `H:` cwd (PowerShell); Git Bash `h:` fails to find
  the runner. Local only.

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
