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
| 3.5 | Field Awards | Not started | Client source is now `../docs/Field Awards #1.xlsx` (2026-10-28, 28 rows; supersedes `Draft_for_FieldAwards v2.xlsx`: Go Around is redefined as a full green Trip after a non-full one, Quad-Engine Royalty lists military types). Awards pay no Miles or Status Points. Use exactly the client's rows; the backend owns the catalog and progress (C12, 2026-10-28), delivered to Unity as data |

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
| 5.1 | UGS progress mirror | Done (local, uncommitted), UGS not contacted | Decision 2026-10-28 (see Design rules). `PUT /v1/me/ugs-link` (server-side link proof via UGS Player Auth admin, strict body, 400/403/404/409/503 mapping), migration 0006 (`ugs_links`, `ugs_mirror_outbox`, `ugs_mirror_deletions`), `enqueueMirror` called inside every progress-changing transaction (Round result, hint spend, hint pack, Active Rank, player create) with a test per write path, in-process worker (SKIP LOCKED lease, token bucket `UGS_MIRROR_MAX_PER_MIN`, 429 pause, per-row backoff), account-deletion cleanup via `ugs_mirror_deletions`. UGS reached only through an injected fetcher; tests stub it. UNVERIFIED (ASSUMPTION tests): token claim names `project_id`/`upid`/`envId`; OIDC `externalId` = Firebase uid. **Open, all need user sign-off in the UGS dashboard:** create the OIDC provider for Firebase, enable the Player Auth admin API, create a service account with Cloud Save Editor + `player_auth.users.get`, then set the `UGS_*` variables; run one real link end to end and decode a real token to settle the UNVERIFIED items. Follow-up (with releases): content via CCD/Remote Config with a Bunny backup |
| 5.C | Trips / Field Awards / Clipper Cards / Logbook / content manifest contracts (C5, C12; contract rounds 1 and 2) | **Designed, not built** (2026-10-29, uncommitted) | Design: [design/trips-awards-logbook.md](design/trips-awards-logbook.md) (lifecycle, server vs client facts, all 28 Field Awards on the Unity code ids, data model 0009–0011, PlayerBalance steps, manifest/ETag, admin publish path, UGS copy proposal, open questions U1–U14 / J1–J11 / A1–A12, slices T1–T6). Contract: `x-planned` operations in `openapi.yaml` (`POST /v1/trips`, `POST /v1/trips/{tripId}/complete`, `.../abandon`, `GET /v1/me/logbook`, `GET /v1/content/manifest`, `GET /v1/content/documents/{name}/{version}`), planned changes to the Round issue/result routes (`x-planned-change`), planned error codes (`x-planned-enum`). The parity test skips planned operations for "route exists" and asserts each answers 404 `not_found` today. Built change: the result route documents `Idempotency-Key` as accepted and ignored (contract round 2). No `src/` change, no migration. Next: user answers U1–U14, then T1 |
| 5.D | Slice T1 of 5.C: pure Trip / Field Award / Clipper Card rules (`docs/design/trips-awards-logbook.md` section 13) | **Done (local, uncommitted)** 2026-10-29 | Pure TypeScript in `src/rules/`, no route, no migration, no `bankRound` change (per-segment Perfect Streak = `nextTripStreak` from `OPENING_TRIP_STREAK`; T2 passes the segment streak as `state.perfectStreak`). `trips.ts` (day log + 7-day hint, Trip hint +1 per 4, `applyCompletedTrip`/`withTrip` counters, Go Around, Red-Eye window, local date from instant + offset), `clipper-cards.ts` (commercial family key, Military key = NFC/collapse/trim/lower-case answer text, `recordSighting`), `aircraft-tags.ts` (Unity table seeded provisional, keyed by Card key), `field-award-catalog.ts` (28 awards on the Unity code ids, sheet text verbatim, `provisional` on the eight tag awards), `field-awards.ts` (metrics, `evaluateFieldAwards`, `nearlyThere`). Tests `test/trips.test.ts`, `test/field-awards.test.ts` (101) with Unity-aligned names and `ASSUMPTION` tests A1-A3, A10, A12-A20 and J1/J3/J10. Independent review done 2026-10-29 and fixed (see the verification log). New assumptions A13-A20 and client question J12 are in the design doc. Next: T2 (segments and Rounds, migration 0009) |
| 5.E | Slice T2 of 5.C: Flight Segments (Unity Trips) and Rounds inside them (`docs/design/trips-awards-logbook.md`, "T2 as built") | **Done (local, uncommitted)** 2026-10-29, awaiting independent review | **BREAKING contract change Unity must adopt (API 0.4.0):** `POST /v1/rounds` takes `{ tripId }` instead of `{ module }`; `POST /v1/rounds/:id/result` requires `aircraftKey`, `answerMs`, `attempts`; `IssuedRound` gains `tripId`, `flightNumber`; the result response gains `hintGrants` and `trip`. Old bodies are 400 `invalid_request`. New: `POST /v1/trips` (required `Idempotency-Key`, 201 / 200 replay, 422 `local_date_mismatch`, 409 `trip_full`) and `POST /v1/trips/:id/abandon`. Migration `0009_trips_and_segments` (generated; `trips`, `player_counters`, `rounds` + 8 columns, `content_items.card_key`, `hint_ledger_kind_check` + `trip_grant`, `day_streak_grant`; 0000-0008 untouched; a second `db:generate` reports no changes). `src/trips/` (service, controller, `trip-store.ts` shared with `RoundsService`), `src/rules/flight-facts.ts` (pure module rules for the Flight facts: commercial key gate against `SEED_COMMERCIAL_CARD_KEYS`, attempts >= errorCount, answerMs <= server elapsed + 2 s), `localDateMatches` in `rules/trips.ts`. D-3: the stored streak is the open segment's, reset at open / abandon / expiry (version bumped only when it was not 0). Day streak in `player_counters`, +1 hint `day_streak_grant` (ref = local date) on every 7th consecutive local day, replay-stable via `rounds.day_streak_grant`. Expiry 30 minutes after the last activity, lazy. Military `aircraftKey` = content item id; its Card key is frozen on the item (`content_items.card_key`, set by the importer on create or at first use). **Interim:** a full open segment blocks `POST /v1/trips` with 409 `trip_full` until T3's `complete` exists. Balance guard extended (`TRIP_WRITERS`). Tests: `test/trips.e2e.test.ts` (53), `test/trip-segments.test.ts` (16 unit), contract and schema-parity updates; existing `api`, `ugs`, `ugs-pacing`, `openapi` e2e adapted (see the verification log). Next: independent review, then T3 (complete) |
| 5.2+ | Follow-ups (not started) | — | Releases and versioned packages with rollback; player content delivery and Rounds tied to a release; server-side answer checks (closes the client-reported-results gap); photo upload/serving; retire and edit-in-place endpoints; importers for the other seven modules; website admin integration; first `bunny:check` against the real zone (needs sign-off and the zone password) |

Field Awards: since C12 (2026-10-28) the backend owns the catalog and progress; built after the Trips
contract (see Decisions). The contract is designed (5.C); 3.2's Trip/7-day hint grants and 3.5 are slices T2–T3 there.

#### Deepening brief (`../docs/briefs/backend.md`)

| # | Job | State | Notes |
|---|---|---|---|
| S1 | Active Rank 404 race fix | Done (committed b1ca340) | |
| S2 | `PlayerBalance` core | Done (local, uncommitted, not independently reviewed) | `src/balance/` (`player-balance.ts`, `balance.module.ts`, `ledger-kinds.ts`). `RoundsService` (issue, complete, hint), `ShopService` and `PlayersService.setActiveRank` go through `PlayerBalance.update`; none of them import `players`, the ledgers or `enqueueMirror` for those writes any more. D-1 applied: an Active Rank change bumps `version` and enqueues (same value = no-op); `version` added to `Progress` (openapi, `progressView`). A completed Round keeps its unconditional bump, even when it pays nothing. No new ledger kind, no schema change, no migration. Still direct: `ensurePlayer`, `deletePlayer`, `UgsLinkService` (S3) |
| S3 | Player lifecycle and UGS link through `PlayerBalance` | Done (local, uncommitted, not independently reviewed) | `PlayerBalance.open` (ensurePlayer; INSERT ... ON CONFLICT DO NOTHING, only the creator writes the starter ledger row and enqueues at version 1), `erase` (deletePlayer; lock first, records the UGS deletion row, uses the request clock, idempotent) and `linkUgs` (link / re-link / stale-holder move; the network proof stays outside the transaction). D-1 for links: a FIRST link enqueues at the current version with no bump; a re-link to a DIFFERENT UGS player bumps `version` and enqueues; re-linking the SAME UGS player changes nothing (shortcut kept, no admin call); a stale-holder move bumps the caller, not the old holder. `src/ugs/outbox.ts` moved to `src/balance/mirror-outbox.ts` (`enqueueMirror`, `queueMirrorDeletion`, `cancelMirrorDeletion`, `dropMirror`), private to the module. `test/balance-guard.test.ts` (unit): no file outside `src/balance/` locks `players` FOR UPDATE, calls the helpers or inserts into the mirror queue/ledgers, and no test imports the module; multiline regex over comment-stripped source, with the checker proven on seeded violations. `ugs.e2e` keeps the hint-spend and hint-pack replay tests (replay leaves outbox generation and version unchanged); the rolled-back enqueue test moved to `player-balance.e2e`. Review fixes: the guard also covers interpolated/quoted/qualified raw SQL tables, direct writes to players/ugs_links/ledgers, `.for(` with any argument, dynamic/ext-less imports of mirror-outbox, `;` inside literals, table imports (allowlist: mirror worker) and table aliasing; the opposite stale-holder test now uses a real lock barrier. No schema change, no migration |
| S4 | Pure `bankRound`; Pleasure Cruise and First Class rules into `src/rules` | Done (local, uncommitted, not independently reviewed) | `src/rules/banking.ts` (`bankRound(state, input, now)`), `first-class.ts` (`hasFirstClassPass(firstClassUntil, now)`, strictly after now), `isPleasureCruise` in `ranks.ts`; `completeRound`, `issueRound` and `progressView` use them. No behaviour change; `completeRound` still bumps unconditionally (D-1). Perfect Streak unchanged (D-3 hooks in at `bankRound`). Unit tests in `test/rules.test.ts` |
| S5 | Schema CHECK parity test | Done (local, uncommitted, not independently reviewed) | Test, no migration (derivation was rejected: it would rewrite the CHECK text and force a drop/re-add migration). `test/schema-parity.test.ts` (unit, in `vitest.config.ts`) renders every `schema.ts` check with `PgDialect` and asserts set equality (plus no duplicates) with `MODULE_IDS`, `RANKS`, `MILES_LEDGER_KINDS`, `HINT_LEDGER_KINDS` and the new `src/db/enums.ts` lists (round status/completion, content status/source, admin audit action; typed onto the columns with `$type<>()`, and `isStatus` uses the list). An enumerated CHECK without a TS list also fails. `test/schema-parity.e2e.test.ts` does the same against `pg_get_constraintdef` on the migrated `airplane_games_test`. Helper and expectations in `test/schema-parity.ts`; the comparison is proven on seeded mismatches. A new ledger kind (S8) or module now needs the TS list, the `schema.ts` literal and a generated migration. No migration, no behaviour change |
| S6 | `MirrorQueue` split of the mirror worker | Done (local, uncommitted; independently reviewed) | `src/ugs/mirror-queue.ts`: `MirrorQueue` interface (`op`, `claim`, `process`, `release`, `fail`, `drop`, `backlog`), exported `Claimed`, and two Postgres adapters, `ProgressWriteQueue` (outbox) and `CopyDeletionQueue` (deletions); the shared lease SQL is one helper over typed table/column handles (no `sql.identifier` strings). `MirrorWorker` keeps policy only and loops over `[deletions, writes]`; the once-log key is `${op}:${key}`; `TickSummary` unchanged; constructor unchanged plus an optional queues override (`UGS_MIRROR_QUEUES`). Pause, token and pause-until sit behind three private methods (`isPaused`, `takeToken`, `pause`), the S7 hook. Test double `test/in-memory-mirror-queue.ts` + new `test/mirror-worker.test.ts` (unit, in `vitest.config.ts`). The Postgres adapters live in `src/ugs` (they only update/delete rows); `balance-guard` allowlist entry moved from `mirror-worker.ts` to `mirror-queue.ts`. No behaviour, schema or migration change; `ugs.e2e` gains one priority test (1-token budget, one due deletion + one due write: only the deletion is processed). Independent review: a pure refactor, no behaviour findings; the findings were test-double fidelity (re-add keeps due_at/claim/attempts; a generation change under our claim makes the row due now; deletion generation 0), the untested production priority order (now `defaultMirrorQueues`, unit- and e2e-tested) and a `process` doc that implied row isolation; all fixed. Deliberate deviation from the plan: `release/fail/drop` take the `Claimed` row, not `(key, …)`, so they match only our own claim. Follow-up (pre-existing, not fixed here): a fetch aborted at shutdown is counted as a transient failure (row gets an attempt and a backoff) instead of being released without an attempt |
| S7 | Shared UGS budget (D-4) and per-player write interval (C3) | Done (local, uncommitted; independently reviewed, findings fixed 2026-10-29, see the review-fix paragraph at the end of this row) | Migration `0008_ugs_budget_and_pace` (generated; `drizzle-kit generate` against the S6 schema first reported no changes, so 0008 holds only: `ugs_budget` (name PK, `tokens` double with CHECK >= 0, `refilled_at`, `paused_until`), `ugs_mirror_pace` (player_id PK -> players ON DELETE CASCADE, `ugs_player_id`, `last_mirrored_at`) and that FK; 0000-0007 untouched). **D-4:** `src/ugs/budget.ts` `UgsBudget` { reserve, refund, pause, isPaused } with `PostgresUgsBudget` (row `cloud_save_admin`; `reserve` = short transaction, SELECT FOR UPDATE, pure `refillTokens` shared with `TokenBucket`, UPDATE; `refund` and `pause` single atomic statements; pause only ever extends via GREATEST) and `InMemoryUgsBudget`; link proofs use their own row `player_auth_admin` (`UGS_PROOF_BUDGET` replaces `UGS_PROOF_BUCKET`); the 5/hour per principal stays in memory per instance (documented). The worker reserves up to 20 before claiming, claims at most that many, refunds unspent tokens in a `finally`; 429 and 401/403 call `budget.pause`, so every instance stops. The three private methods from S6 are gone. **C3:** `UGS_MIRROR_MIN_INTERVAL_SEC` (default 300, 0-3600, 0 disables; optional like `UGS_MIRROR_MAX_PER_MIN`, so not one of the five required, but setting it alone fails the all-or-none rule so a stray knob cannot silently leave the mirror off). The durable `last_mirrored_at` is in `ugs_mirror_pace`, not a column on `ugs_links` or a kept outbox row: `ugs_links` is written only by `PlayerBalance` (balance guard) and the worker must record the time, a kept row would break backlog/lag and the one-row-per-player coalescing, and the stored `ugs_player_id` makes "first write after a link / re-link / move" fall out without any reset code. `enqueueMirror` (still private to `src/balance`, guard allowlist unchanged) takes `{ minIntervalSec, dueNow }`: new row due = GREATEST(now, last + interval), existing row keeps its due_at; `ProgressWriteQueue` records the pace row before removing the outbox row and re-queues a changed-while-writing row at now + interval; deletions never use it. The Trip-end hook is `Step.mirrorNow` / `enqueueMirror({ dueNow })` (due now, pulls a waiting unclaimed row with attempts 0 forward); nothing sets it yet and no Trips are built. `mirrorDueAt()` in mirror-policy is the spec of the SQL and an e2e test pins them. Tests: shared contract `test/ugs-budget-contract.ts` run on both adapters; `test/ugs-pacing.e2e.test.ts` (two workers on one row never exceed the burst, with a separate-buckets control that writes 20; 429 and 401 on one instance pause the other; refund; interval cases; dueNow); unit tests in `ugs.test.ts` and `mirror-worker.test.ts`; the in-memory queue double models the interval. Existing `ugs.e2e.test.ts` runs with interval 0 and a fresh budget row per test. Fix found by the tests: a stale write finishing after its player was deleted must not violate the pace FK (insert is conditional on the live link, 23503 ignored) **Review fixes (2026-10-29, independent review; 0008 regenerated, still uncommitted):** (1) re-link while a row waits: the enqueue conflict takes `LEAST(existing due_at, EXCLUDED.due_at)` for an unclaimed row with attempts 0 (EXCLUDED derives from the pace row of the CURRENT link, so a same-link Round still coalesces); this subsumes the old `dueNow` branch. (2) "Changed while writing" reset (`ProgressWriteQueue.resetChanged`) is due now when `urgent` or interval 0, else GREATEST(now, last + interval) from the pace row of the CURRENT link, now when none (re-link/move during the write). An urgent enqueue on a claimed row is persisted in the new `ugs_mirror_outbox.urgent boolean NOT NULL DEFAULT false` column: `due_at` is the lease while claimed (moving it would drop the in-flight write's protection and the lease-expiry crash recovery), so a flag is the sound carrier; reset, release and fail clear it. 0008 therefore also has `ALTER TABLE ugs_mirror_outbox ADD COLUMN urgent`. (3) `PostgresUgsBudget` uses database time (`clock_timestamp()`) for refill and pause (`pause(untilMs, nowMs)` keeps only the duration; option `time: "database" | "caller"`, default database; `UgsWorkerOptions.budgetTime` lets tests with explicit clocks use the caller's); `refillTokens` clamps a stored refill time more than 5 min ahead of now. (4) The worker skips `reserve` when backlog is 0 and reserves min(backlog, 20); a refund that throws is logged and does not mask the original error. (5) Pause survival and the `UPDATE ugs_budget SET paused_until = NULL WHERE name = 'cloud_save_admin'` reset documented in README and ARCHITECTURE. Nits: `pause()` no longer calls `new Date()`; `Step.mirrorNow` documented as applying only when the step enqueues; balance guard rule "writes ugs_mirror_pace" (allowed only in src/balance and `src/ugs/mirror-queue.ts` via `PACE_WRITERS`, with seeded tests and a stale-entry check); "never delayed" wording corrected. Not done: refunding the link-proof token on a failed attempt, because nothing can fail between `reserve` and the admin call (the call is the next statement; an `unavailable` answer means the call was made) |

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
- 2026-10-27: backend Postgres owns all progress; no UGS Economy. (The "UGS keeps no copy" half was reversed on
  2026-10-28, next entry.)
- 2026-10-28 (user), 5.1 UGS mirror: UGS is the game's first support path and reads progress (later content) from UGS
  first; the backend server is the authority and backup. Postgres stays the only writer and computes every award; UGS
  gets a one-way, server-written, player-read-only Cloud Save mirror (Protected `progress`). The game never writes
  progress to UGS; the backend never reads it back. Reverses the 2026-10-27 "UGS keeps no copy" ruling. See
  ARCHITECTURE.md "Unity Gaming Services".
- 2026-10-28 (user): a client-sheet import into an EMPTY module must also have unique, non-blank trimmed `file` names
  (row error otherwise), same as the non-empty case, so later sheets can always match by file name. The real client
  sheet (31 rows) still imports 31 items.
- 2026-10-28: an admin edit of a retired item leaves it retired (only a client sheet listing it again returns it to
  `approved`).
- 2026-10-28 (user, cross-repo rulings via `../docs/PROJECT_STATE.md` §3): C1 backend Postgres owns editorial
  content and the website desks become clients of the staff admin API (server-to-server through the Worker with
  the staff member's own token); releases (5.2+) are built here. C3 the game shows the UGS copy first, then
  checks the server; a higher server `version` wins on screen and the copy is re-queued. C4 the backend verifies
  store receipts itself (Phase 4 as designed; no Cloud Code in the purchase path). C5 the backend owns the
  `/v1/trips` contract. C8 vocabulary: backend Round = one Flight, Flight Segment = Trip (Unity ADR-0007). C12
  the backend records first and Unity receives as data: content, the Field Award catalog text and thresholds,
  aircraft tags, Field Award progress, Go Around (from server Trips) and Logbook history. **This reverses
  "Unity owns the Field Award catalog"** (3.5 and the Phase 5 note). PROJECT_STATE §4 row C10 said the
  opposite; the docs session marked it resolved by C12 on 2026-10-29.
- 2026-10-29 (user), order after the 5.0/5.1 review and commits: C8 line in CLAUDE.md, then the deepening
  brief `../docs/briefs/backend.md` S1–S7 (the per-player UGS write interval folds into S6/S7), then the Trips,
  Field Award, Logbook and admin-update delivery contracts on top of PlayerBalance, then the catalog/dealer
  slices B1–B5 (`../docs/briefs/cross-repo-catalog-dealer.md`). S8 waits for Phase 4.
- 2026-10-29 (user), superseding the strict "then B1–B5" above: interleave, one slice at a time, each reviewed and
  committed before the next: T2 → B1 → B2 → T3 → B3 → B4 → B5 → T4 → T5 → T6, then releases and server dealing.
  B1–B2 go first because they unblock the website and Unity consumers. B5 comes after T2, which changes
  `content.service.ts`. The B slices follow the brief's "Refresh 2026-10-29" section.
- 2026-10-29 (user) D-1: an Active Rank change and a UGS re-link bump `players.version`, and `GET /v1/me/progress`
  exposes `version` (needed for C3). D-4: cross-instance UGS budget is a shared Postgres row (S7); link-proof
  calls get their own row. D-5: the module catalog originates in Unity `ModuleRegistry`; the backend mirrors it.
  D-3 (relayed by the docs session as a user ruling, recorded in `../docs/PROJECT_STATE.md` §3): the Perfect
  Streak counts per Trip (Unity's 2026-09-03 ruling); the backend's lifetime counter changes to per Trip before the
  server Trip work (B5). D-2: game content for Military, Aircraft Identifier and Plane of the Day moves to this admin
  store (photographer submissions stay in website D1), so the website will need admin endpoints for those modules.
- 2026-10-29 (user): this session owns the Backend repo (one session per repo); other backend sessions are read-only.
- 2026-10-29 (user), contract round 1 for Trips / Field Awards / admin delivery (C5, C12): (1) **server-issued
  Trip**: `POST /v1/trips` opens one (module, localDate, utcOffsetMinutes, contentVersion), every Round belongs to an
  open Trip, `POST /v1/trips/:id/complete` after the 10th Flight returns the Trip outcome, Field Awards earned and
  Clipper Cards, idempotent; per-Trip Perfect Streak (D-3), Go Around and Trip hint grants hang off it (ADR-0008 §2).
  (2) Field Award **ids are the Unity code ids** (`Achievements.cs`) so earned progress survives; titles, criteria
  and thresholds come exactly from `Field Awards #1.xlsx` (10 of 28 ids differ from the sheet snapshot). (3) Admin
  updates reach the app by **pull manifest**: `GET /v1/content/manifest` (versions + hashes) and versioned data
  documents, pulled by Unity's existing HttpContentManifestService; Remote Config stays kill switch / pointer only;
  CCD/Bunny for large files with releases. (4) A Trip **deals at Active Rank** (Pleasure Cruise plays that rank's
  questions; Unity's mock, which deals at Certified, changes).
- 2026-10-29 (user), contract round 2: (1) **Logbook** = `GET /v1/me/logbook` derived from stored Trips/Flights:
  recent Flights (last 20), daily log, lifetime totals, Clipper Card records, Field Awards earned; no new client
  writes. (2) **Server answer checks come later**, with the dealer slices B1–B5 and releases; Trips v1 records
  client-reported Flight facts. (The website's BACKEND_SYNC_PLAN.md claims a 10-28 answer-check ruling that
  PROJECT_STATE does not record; flagged to the docs session.) (3) **Trip hint grants mirror Unity HintBank**
  (+1 per 4 Trips, +1 per 7-day streak) as new hint_ledger kinds with a CHECK migration; unruled details are
  `ASSUMPTION:` tests. (4) **Clipper Cards for commercial and Military** aircraft. Because the client's Military sheet
  has no families (use only client-supplied content), a Military Card is keyed by the client's answer text,
  normalised (trim, case-fold, collapse spaces), so repeated rows (Typhoon ×3) share one Card and variants stay
  separate until the client supplies a family mapping (client question). Commercial Cards keep Unity's families.
  The Unity app's undocumented `Idempotency-Key` on the Round result route is documented as accepted and ignored
  (the Round id already makes it idempotent).
- 2026-10-29 (user), contract design questions U1–U14 (`docs/design/trips-awards-logbook.md` §12): all take the
  recommended answer. Notably U8: Unity's aircraft tag table (authored by us, not the client) is seeded marked
  `provisional` and the tag awards count it until the client's attribute grid arrives (client question J5); U2:
  earning a Field Award does not bump `players.version`; U11: manifest and documents require sign-in; U12: a
  mismatched `localDate` is 422; U14: `POST /v1/trips` takes a required `Idempotency-Key` (contract updated).
  Josh's J1–J11 stay open.
- 2026-10-29 (T2, implementer's choices, for review): (1) **POST /v1/rounds and the result route changed shape (API 0.4.0)**:
  Unity must send `{ tripId }` and the Flight facts; the old bodies are 400. Recorded in README, `openapi.yaml` and the design
  doc. (2) **Interim for a full segment**: `POST /v1/trips` answers 409 `trip_full` while the open segment has ten banked
  Rounds, because completing it is T3; abandoning would lose its Cards, counters and awards. T3 turns this into
  complete-then-open. (3) `trip_expired` is also a result-route 410 (a live Round whose segment ran out first). (4) An expired
  segment is closed at its expiry (`closed_at = expires_at`), which is how `trip_expired` is told from `trip_closed`.
  (5) `GET /v1/me/progress` reads `perfectStreak` as 0 when no live segment holds the stored streak (U13 with lazy expiry).
  (6) The Military Card key is frozen on `content_items.card_key` (importer on create, first use for older rows).
  (7) The Idempotency-Key replay is answered before the localDate check. None of these is a user ruling yet.
- 2026-10-29 (T2 review fixes): a Round's own expiry now decides before the segment status, so a retried result stays
  `round_expired` (and `trip_expired` is defensive only); a hint needs a live segment; every Progress view (routes and the UGS
  mirror) uses `withLiveStreak`; a reused Idempotency-Key with another module is 422 `idempotency_key_reused`. The Military
  `card_key` stays a runtime freeze (importer on create, first use for older rows); the alternative is a backfill migration that
  fills `card_key` for existing rows once. Spec ambiguities are `ASSUMPTION:` tests (A2, A6, A8, A9, the interim `trip_full`
  block, defensive `trip_expired`, the runtime freeze).
- 2026-10-29 (user, from the S3 review): the UGS copy names its owner. Snapshot `schemaVersion` 2 adds `uid` (the
  Firebase uid); the game uses a copy only when `uid` is the signed-in user, and compares `version` only between copies
  of one owner. Reason: after a link move or an erase + re-link, the UGS item can hold the previous owner's copy (with
  a higher version) until the worker rewrites it.

## Open questions for Josh

See README "Open questions". Also: Apple's App Store guidelines generally require Sign in with Apple
when Google sign-in is offered; the project rule currently allows only email/password and Google.

## Verification log

- 2026-10-29 (B2 publish contracts/catalog.v1.json, implementer's run, before review): `renderCatalogJson()` added to `src/rules/catalog.ts` (pure; derived from `RANKS`, `RANK_THRESHOLDS`, `RANK_CATALOG`, `MODULE_CATALOG`, `modulesInTicketOrder()` and the trip constants; `format: 'catalog.v1'`, 2-space, LF, trailing newline). `npm run contracts:write` = `nest build && node scripts/write-contracts.mjs` (bunny-check pattern, no new dependency) writes `contracts/catalog.v1.json`; `contracts/README.md` states the guarantee and versioning (additive only in v1; rename/removal/reorder = `catalog.v2`); `.gitattributes` pins `contracts/*.json` to LF because `core.autocrlf=true` here would otherwise break the byte comparison and consumers' verbatim copies. New `test/contracts.test.ts` (6 tests, added to the `vitest.config.ts` include list): byte-for-byte stale check whose message names `npm run contracts:write`, format stability, unique ids/unity names/slugs, ranks lowest first with trainee 0 and strictly ascending, tickets 1..8 in order, trip 10/6. Seeded drift (400000 -> 200000 in the file) failed the stale test with the message, then restored. From PowerShell in `H:\Work\TheAviationArcade\Backend`, Postgres up: `npm run typecheck` clean; `npm test` 20 files, 440/440; `npm run db:migrate` applied cleanly; `npm run test:e2e` 9 files, 331/331; `npm run build` clean; `npm run db:generate` "No schema changes". No migration, no cloud call. Local only; not committed.

- 2026-10-29 (B1 catalog module, implementer's run): new `src/rules/catalog.ts` (pure): `RANK_CATALOG` (`{unity,name}` per Rank) and
  `MODULE_CATALOG` (`{unity,slug,ticket}` per ModuleId), typed `Record<Rank|ModuleId,...>` so a missing key fails typecheck; re-exports
  `FLIGHTS_PER_TRIP`, adds `MAX_FLIGHTS_AT_OWN_RANK = 6`, `rankDisplayName`, `rankFromDisplayName` (trim, collapse whitespace, case-insensitive;
  miss = `undefined`, as `LEVELS.find` was) and `modulesInTicketOrder`. `RANKS`/`MODULE_IDS` literals untouched. `military.ts` `LEVELS` removed,
  now uses the catalog. `test/catalog.test.ts` (8 tests) added to `vitest.config.ts`. Names and slugs checked against Unity `ModuleRegistry.cs`
  and `FlightRankExtensions.DisplayName` (read only): no differences from the brief. From PowerShell in `H:\Work\TheAviationArcade\Backend`:
  `npm run typecheck` clean; `npm test` 19 files, 434/434 (was 426; +8); `npm run db:migrate` OK; `npm run test:e2e` 9 files, 331/331;
  `npm run build` clean; `npm run db:generate` "No schema changes". `military-mapping.test.ts` unchanged and green. Not committed.

- 2026-10-29 (T2 segments and Rounds, implementer's run, before review): from PowerShell in `H:\Work\TheAviationArcade\Backend`, `docker compose up -d`.
  `npm run db:generate` produced `0009_trips_and_segments` with only T2's DDL (a second run: "No schema changes"); `npm run typecheck` clean;
  `npm test` 18 files, 426/426 (was 407; +16 in `trip-segments.test.ts`, +3 in the balance guard for the new writes rule);
  `npm run db:migrate` applied 0009 to the dev database; `npm run test:e2e` 9 files, 319/319 (was 8 files, 266; +`trips.e2e.test.ts` 53, the
  openapi parity file now serves the two Trip operations, the live-schema parity test covers the new CHECK lists); `npm run build` clean.
  Existing tests changed (assertions kept, setup adapted): `api.test.ts` helper `startRound` now opens a Flight Segment (kept per player and
  module, so Rounds of one test share it and the streak accumulates; a full segment is closed by SQL because completion is T3) and issues with
  `{ tripId }`, `PERFECT_FAST` gained the Flight facts, the "perfect streak" test sends `attempts: 3` with `errorCount: 2` (new rule
  attempts >= errorCount), the module-rejection test now rejects bad modules at `POST /v1/trips` (and the old `{ module }` Round body),
  the unauthenticated-route count is 17 (two Trip routes), "every ModuleId" banks with module-correct facts (a Military item is seeded);
  `ugs.e2e`/`ugs-pacing.e2e` `bankRound` helpers issue through the shared segment helper (`test/trip-helpers.ts`) and send facts;
  `openapi.e2e` replaces the `RoundResultRequest`/`StartRoundRequest` cases with the new schemas, opens a segment first and validates
  `FlightSegmentEnvelope`/`FlightSegmentAbandoned`; `schema-parity.ts` lists the new CHECKs. No cloud call. Local only.

- 2026-10-29 (T1 review fixes): independent review findings H1, M1-M5, L1-L5 and nits fixed in `src/rules/` and the design doc. Go Around "green" kept as any correct Flight but every Go Around test is now `ASSUMPTION A18` (J12 asked) plus a test that 10 hinted correct Flights after a non-full Trip earn it; `Boeing F/A-18 Super Hornet` is not a client correct answer (wrong option in mil-a4) so the sheet has 27 distinct correct answers (verified against the real xlsx with openpyxl and by a vitest that parses it), the spelling moved to the pre-tagged group; Card key normalisation strips Cf characters, folds dashes, treats NEL as whitespace, collapses spaces around `/`; Military keys are `mil:`-prefixed and frozen on the item at first import (design 3.5, A14, A20); `cardKeyFor(module, value, catalog)` returns card / no_card / unknown_aircraft and a commercial key outside the seeded catalog is a 400 `invalid_request` rule for T2/T3 (design 3.2); `effectiveTarget` clamps targets to integers >= 1 and `nearlyThere` never divides by 0; the snapshot test uses `it.skipIf`; unruled readings (Miles completed-only J10, Red-Eye end A19, A10) are `ASSUMPTION` tests; A2 and A13-completed-only are labelled placeholders for the T2/T3 e2e. From PowerShell in `H:\Work\TheAviationArcade\Backend`, `docker compose up -d`: `npm run typecheck` clean; `npm test` 17 files, 407/407 (was 395); `npm run test:e2e` 8 files, 266/266; `npm run build` clean. No migration, no cloud call. Local only.

- 2026-10-29 (T1 pure rules): from PowerShell in `H:\Work\TheAviationArcade\Backend`, `docker compose up -d` (Postgres running).
  `npm run typecheck` clean; `npm test` 17 files, 395/395 (was 15 files, 306: +89 in `trips.test.ts` and `field-awards.test.ts`; first run had one wrong expectation in my own history scenario, fixed);
  `npm run test:e2e` 8 files, 266/266 (unchanged); `npm run build` clean. No migration, no cloud call, no change to built routes. The catalog test also compares title, criteria,
  threshold cell and hidden flag with the Unity snapshot `field-awards.json` when that file exists on the machine. Local only.

- 2026-10-29 (5.C contracts, design only): from PowerShell in `H:\Work\TheAviationArcade\Backend`, `docker compose up -d` (Postgres running).
  `npm run typecheck` clean; `npm test` 15 files, 306/306; `npm run test:e2e` 8 files, 266/266 (`openapi.e2e.test.ts` 9 → 15: planned operations not
  registered and 404 `not_found`, planned-only codes = `x-planned-enum`, planned request bodies strict, manifest keeps Unity's `ManifestWire`/`ModuleWire`
  fields, 28 Field Award ids, planned response samples; the result route accepts and ignores `Idempotency-Key`); `npm run build` clean. Mutation checks:
  removing `x-planned` from `GET /v1/me/logbook` failed the route-parity test; removing `local_date_mismatch` from `x-planned-enum` failed the
  planned-codes test (both restored). No `src/` change, no migration, nothing committed. Local only.

- 2026-10-29 (S7, shared UGS budget and write interval; D-4, C3): from PowerShell in `H:\Work\TheAviationArcade\Backend` with Postgres up.
  Before editing `schema.ts`, `drizzle-kit generate` reported "No schema changes"; after, it generated `0008_ugs_budget_and_pace` with only the two
  tables, the CHECK and the FK; a second `drizzle-kit generate` afterwards: "No schema changes". `npm run typecheck` clean; `npm test` 15 files, 296/296;
  `npm run db:migrate` applied 0008 to the dev database; `npm run test:e2e` 8 files, 250/250 (new `ugs-pacing.e2e.test.ts` 20 tests, incl. the Postgres run of the
  budget contract); `npm run build` clean. Mutation check: pointing worker B at a different budget row in the shared-budget test failed it with
  "expected 20 to be 10" (restored). The one "integer out of range" error line in the e2e output is `api.test.ts`'s deliberate overflow test, as before.
  Local only: no cloud calls, nothing contacts UGS.
- 2026-10-29 (S7 independent-review fixes): from PowerShell in `H:\Work\TheAviationArcade\Backend`. 0008 regenerated: rolled back in `airplane_games` and
  `airplane_games_test` (dropped `ugs_mirror_pace` and `ugs_budget`, deleted the `drizzle.__drizzle_migrations` row for 0008 in both), deleted the old
  0008 file and snapshot, restored the journal, edited `schema.ts` (`ugs_mirror_outbox.urgent`), `npm run db:generate -- --name ugs_budget_and_pace`
  (same tag, two tables + FK + `ADD COLUMN "urgent" boolean DEFAULT false NOT NULL`), `npm run db:migrate` applied it to dev; the test DB migrates in global setup;
  a second `db:generate`: "No schema changes". `npm run typecheck` clean; `npm test` 15 files, 306/306; `npm run test:e2e` 8 files, 260/260 (`ugs-pacing.e2e.test.ts`
  30 tests: re-link while waiting, re-link during write, urgent during write, plain change during write, database-time budget x4, idle tick); `npm run build` clean.
  Mutation check: replacing `LEAST(...)` with the old `due_at` in the enqueue conflict failed the re-link test and the dueNow test (restored). Local only.

- 2026-10-29 (S5 schema parity): typecheck clean; `npm test` 251/251 (14 files, incl. 7 new parity tests); `npm run test:e2e` 229/229 (7 files, incl. the live `pg_get_constraintdef` check); `npm run build` clean. Seeded mismatch: removing 'round_spend' from `hint_ledger_kind_check` in `schema.ts` failed the unit test with a diff naming the constraint and the missing value (restored afterwards). The first e2e run found Postgres stores a one-value IN as `= 'x'::text` (admin_audit), not `= ANY`; the filter now covers both. Local only.

- 2026-10-29 (S4, pure `bankRound`): from PowerShell in `H:\Work\TheAviationArcade\Backend` with Postgres up:
  `npm run typecheck` clean; `npm test` 13 files, 244/244 (`rules.test.ts` 23 → 37 tests: isPleasureCruise,
  hasFirstClassPass, bankRound branches; the rest of the +26 since the S3 log came with S3's review fixes and the uid
  change); `npm run test:e2e` 6 files, 228/228, unchanged tests; `npm run build` clean. Independent Opus review: pure
  refactor, a differential run of HEAD vs new over 241,920 input combinations (rank boundaries, streaks, pass expiry
  at ±1 ms, hints paid/claimed, time fractions, Pleasure Cruise) found 0 differences; fixed its nits (test title,
  `ASSUMPTION:` prefix on two server rulings not in points-progression.md). Local only.
- 2026-10-29 (S3, PlayerBalance owns player lifecycle and the UGS link): from PowerShell in
  `H:\Work\TheAviationArcade\Backend` with Postgres up: `npm run typecheck` clean; `npm test` 13 files, 218/218;
  `npm run test:e2e` 6 files, 226/226 (new: open() under 6 concurrent calls = one starter row, erase() linked / unlinked /
  missing, linkUgs first / different / same / stale-holder / held / no_player / opposite moves in parallel, rollback of the
  enqueue); `npm run build` clean. Changed ugs.e2e expectations: a re-link to a different UGS player now bumps `version`
  by one and enqueues at it; a stale-holder move bumps the caller to 2 and leaves the holder. Not independently
  reviewed. Local only, no UGS or cloud call.
- 2026-10-29 (S2 independent review + fixes): Opus review found one regression — a refused spend (the
  `InsufficientBalance` sentinel) made `withTransaction` destroy a healthy pooled connection, so a client tapping a
  spend with no funds churned the pool. Fixed with `ExpectedRollback` (connection kept after a successful ROLLBACK),
  proved by a pool test that fails without the fix (0 vs 1 connection). Also: funds checked before any ledger insert
  (a refusal can't be masked by a UNIQUE violation), exhaustive outcome mapping in setActiveRank, a test that profile +
  balance in one step bump the version once. My run: typecheck clean, `npm test` 211/211, `npm run test:e2e` 218/218,
  `npm run build` OK. Local only.
- 2026-10-29 (S2 `PlayerBalance`, implementer's run, before the review): from PowerShell at
  `H:\Work\TheAviationArcade\Backend`: `npm run typecheck` clean, `npm test` 211/211 (12 files), `npm run test:e2e`
  216/216 (6 files; was 202, +12 `test/player-balance.e2e.test.ts` at the `PlayerBalance` interface, +2 in
  `api.test.ts`: progress `version` and Active Rank bump, an unfinished Round bumps the version once), `npm run build`
  OK. `ugs.e2e` 'Active Rank change' test rewritten from "version kept" to "bumps and enqueues". openapi parity test
  green with `Progress.version`. No schema.ts change beyond a comment, so no `db:generate`, no migration. Local only.

- 2026-10-29 (5.1 independent review + fixes): Opus review (read-only) found no missing enqueue and a sound
  single-instance design; fixed: Player Auth budget exhaustion by one player (shortcut for the recorded link, 5/h per
  principal, 12/min process-wide), copy surviving deletion/re-link with several instances (deletion due after lease +
  timeout), generation ABA after lease expiry (sequence generation + `claim_id`, migration 0007, lease 260 s), stale
  link holder blocking forever (link moves when UGS no longer lists the holder), config all-or-none, credentials
  401/403 global pause, capped 4xx retries, backlog logging, Retry-After decimals, response bodies cancelled. Deferred
  by plan: shared cross-instance budget (S7), per-player write interval (S6/S7), `version` bump on Active Rank (D-1).
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
