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
| 1.2 | Rate limiting | Done (local) | `@nestjs/throttler`, keyed by principal (IP on public routes); 429 `rate_limited` + `Retry-After`. Store shared across instances in Postgres since A4 (2026-11-03, Phase 6 row 6.2) |
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
| 5.0 | Admin content store foundation | Done (local, uncommitted) | Staff-only API (was `STAFF_EMAILS` + verified email; now role-based, ADR-0002): import xlsx → `content_items`, list, export, `GET /v1/admin/me`. Military mapping from the client's sheet (31 rows → `mil-a1`…`mil-a31`, approved, source `client_sheet`). Idempotent by file sha256, all-or-nothing, unzip-bomb guard. Import semantics ruled 2026-10-28 (Q1-Q9 below): client sheets are authoritative with stable ids (matched by `file`), retire missing rows, field diffs and a `planHash` confirm before any overwrite/retire (409 `plan_changed`); admin exports keep versioned edits. `BlobStore` (Bunny S3 with SigV4 / memory / none), migrations 0004 (`content_imports`, `content_items`, `admin_audit`) and 0005 (`retired` status and count). Real Bunny never contacted |
| 5.1 | UGS progress mirror | Done; proven on `development` 2026-11-02 (18/18), not on `production` or from a game sign-in | Decision 2026-10-28 (see Design rules). `PUT /v1/me/ugs-link` (server-side link proof via UGS Player Auth admin, strict body, 400/403/404/409/503 mapping), migration 0006 (`ugs_links`, `ugs_mirror_outbox`, `ugs_mirror_deletions`), `enqueueMirror` called inside every progress-changing transaction (Round result, hint spend, hint pack, Active Rank, player create) with a test per write path, in-process worker (SKIP LOCKED lease, token bucket `UGS_MIRROR_MAX_PER_MIN`, 429 pause, per-row backoff), account-deletion cleanup via `ugs_mirror_deletions`. UGS reached only through an injected fetcher; tests stub it. **Proven on `development` 2026-11-02 (`ugs:check --live`, 18/18, see the verification log):** token claims, `externalId` = Firebase uid, link, copy after the link and after a banked Round. Service account roles: Cloud Save Editor + Authentication Viewer; Player Auth admin API enabled. **Open:** a sign-in from the game itself, and the same setup on `production`. Follow-up (with releases): content via CCD/Remote Config with a Bunny backup |
| 5.C | Trips / Field Awards / Clipper Cards / Logbook / content manifest contracts (C5, C12; contract rounds 1 and 2) | **Designed, not built** (2026-10-29, uncommitted) | Design: [design/trips-awards-logbook.md](design/trips-awards-logbook.md) (lifecycle, server vs client facts, all 28 Field Awards on the Unity code ids, data model 0009–0011, PlayerBalance steps, manifest/ETag, admin publish path, UGS copy proposal, open questions U1–U14 / J1–J11 / A1–A12, slices T1–T6). Contract: `x-planned` operations in `openapi.yaml` (`POST /v1/trips`, `POST /v1/trips/{tripId}/complete`, `.../abandon`, `GET /v1/me/logbook`, `GET /v1/content/manifest`, `GET /v1/content/documents/{name}/{version}`), planned changes to the Round issue/result routes (`x-planned-change`), planned error codes (`x-planned-enum`). The parity test skips planned operations for "route exists" and asserts each answers 404 `not_found` today. Built change: the result route documents `Idempotency-Key` as accepted and ignored (contract round 2). No `src/` change, no migration. Next: user answers U1–U14, then T1 |
| 5.D | Slice T1 of 5.C: pure Trip / Field Award / Clipper Card rules (`docs/design/trips-awards-logbook.md` section 13) | **Done (local, uncommitted)** 2026-10-29 | Pure TypeScript in `src/rules/`, no route, no migration, no `bankRound` change (per-segment Perfect Streak = `nextTripStreak` from `OPENING_TRIP_STREAK`; T2 passes the segment streak as `state.perfectStreak`). `trips.ts` (day log + 7-day hint, Trip hint +1 per 4, `applyCompletedTrip`/`withTrip` counters, Go Around, Red-Eye window, local date from instant + offset), `clipper-cards.ts` (commercial family key, Military key = NFC/collapse/trim/lower-case answer text, `recordSighting`), `aircraft-tags.ts` (Unity table seeded provisional, keyed by Card key), `field-award-catalog.ts` (28 awards on the Unity code ids, sheet text verbatim, `provisional` on the eight tag awards), `field-awards.ts` (metrics, `evaluateFieldAwards`, `nearlyThere`). Tests `test/trips.test.ts`, `test/field-awards.test.ts` (101) with Unity-aligned names and `ASSUMPTION` tests A1-A3, A10, A12-A20 and J1/J3/J10. Independent review done 2026-10-29 and fixed (see the verification log). New assumptions A13-A20 and client question J12 are in the design doc. Next: T2 (segments and Rounds, migration 0009) |
| 5.E | Slice T2 of 5.C: Flight Segments (Unity Trips) and Rounds inside them (`docs/design/trips-awards-logbook.md`, "T2 as built") | **Done (local, uncommitted)** 2026-10-29, awaiting independent review | **BREAKING contract change Unity must adopt (API 0.4.0):** `POST /v1/rounds` takes `{ tripId }` instead of `{ module }`; `POST /v1/rounds/:id/result` requires `aircraftKey`, `answerMs`, `attempts`; `IssuedRound` gains `tripId`, `flightNumber`; the result response gains `hintGrants` and `trip`. Old bodies are 400 `invalid_request`. New: `POST /v1/trips` (required `Idempotency-Key`, 201 / 200 replay, 422 `local_date_mismatch`, 409 `trip_full`) and `POST /v1/trips/:id/abandon`. Migration `0009_trips_and_segments` (generated; `trips`, `player_counters`, `rounds` + 8 columns, `content_items.card_key`, `hint_ledger_kind_check` + `trip_grant`, `day_streak_grant`; 0000-0008 untouched; a second `db:generate` reports no changes). `src/trips/` (service, controller, `trip-store.ts` shared with `RoundsService`), `src/rules/flight-facts.ts` (pure module rules for the Flight facts: commercial key gate against `SEED_COMMERCIAL_CARD_KEYS`, attempts >= errorCount, answerMs <= server elapsed + 2 s), `localDateMatches` in `rules/trips.ts`. D-3: the stored streak is the open segment's, reset at open / abandon / expiry (version bumped only when it was not 0). Day streak in `player_counters`, +1 hint `day_streak_grant` (ref = local date) on every 7th consecutive local day, replay-stable via `rounds.day_streak_grant`. Expiry 30 minutes after the last activity, lazy. Military `aircraftKey` = content item id; its Card key is frozen on the item (`content_items.card_key`, set by the importer on create or at first use). **Interim:** a full open segment blocks `POST /v1/trips` with 409 `trip_full` until T3's `complete` exists. Balance guard extended (`TRIP_WRITERS`). Tests: `test/trips.e2e.test.ts` (53), `test/trip-segments.test.ts` (16 unit), contract and schema-parity updates; existing `api`, `ugs`, `ugs-pacing`, `openapi` e2e adapted (see the verification log). Next: independent review, then T3 (complete) |
| 5.F | Slice T3 of 5.C: complete a Flight Segment (`docs/design/trips-awards-logbook.md`, "T3 as built") | **Done (local, uncommitted)** 2026-10-29, awaiting independent review | **Contract change (API 0.5.0): a new route and one behaviour change.** `POST /v1/trips/:id/complete` (no body) returns `{ trip, fieldAwards, clipperCards, hintGrants, replayed, progress }`; new error code `trip_incomplete` (409, fewer than 10 banked). **Behaviour change Unity must know:** `POST /v1/trips` no longer returns 409 `trip_full` (0.4.0 did); a full open segment is completed first (same transaction), then the new one opens (the app reads that segment's lists by calling `complete`, a replay). Migration `0010_trip_completion` (generated; `player_clipper_cards`, `player_field_awards`; 0000-0009 untouched; second `db:generate`: no changes). `src/trips/trip-completion.ts`, `catalog-in-force.ts` (code constant until T4), `counters-store.ts`; `TripsService.completeTrip`. One transaction via `PlayerBalance.update`: outcome, counters (Go Around, Red-Eye), Cards, all 28 awards, `trip_grant` (+1 per 4th completed segment, ref = tripId), Perfect Streak to 0, `republish` + `mirrorNow`; version bumps only when a hint posts or the streak was not 0 (U2). Replay reads the lists back from the tables (identical, pays nothing). Balance guard: new `AWARD_WRITERS` rule, `trip-completion.ts` in `TRIP_WRITERS`. Tests: 19 new in `test/trips.e2e.test.ts` (incomplete, replay, nothing paid twice, concurrent, race with open, Go Around sequence, 4th-segment grant, Red-Eye, Cards, Military, errors, re-derivation, cascade, CHECKs), 1 in `ugs-pacing.e2e` (`mirrorNow` pulls the write forward), 1 in `openapi.e2e`, guard and parity tests. Open choices C1-C4 and assumptions A21-A24 are in the design doc. Next: independent review, then B3 |
| 5.G | Slice B3: Trip dealer `src/rules/dealer.ts` (brief `../docs/briefs/cross-repo-catalog-dealer.md`, Refresh 2026-10-29) | **Done (local, uncommitted)** 2026-10-29, awaiting independent review | Pure port of both Unity dealers with the same RNG (FNV-1a 32 + xorshift32, Fisher-Yates from the end, `Next(n)=u32%n`, Unity's RNG consumption order). `dealTrip(moduleId, pool, rank, seed)`, `tripCoverage(moduleId, pool)` (per rank, capped at 10), `dealAnswerKey` (port of `MilitaryContent.NormalizeAnswer`, exact on U+0000-U+01C4 only; not the Card key), `dealAnswerKeyIsPortable` (content guard for that range), `dealablePool` (drops blank photos; `dealTrip` deals the pool as given, like Unity; `tripCoverage` counts only `dealablePool`), `wrong.length === 3` enforced, `DEAL_POLICY` (`identifier` lower-ranks, `aircraft-identifier-military` nearest-ranks), `dealTripWithPolicy` for B4's fixture. A Module without a policy throws `DealNotSupportedError` (ASSUMPTION). No route, no contract file, no migration. Tests `test/dealer.test.ts` |
| 5.H | Slice B4: publish `contracts/dealer.v1.json` (brief `../docs/briefs/cross-repo-catalog-dealer.md`, Refresh 2026-10-29) | **Done (local, uncommitted)** 2026-10-29, awaiting independent review | Golden Trip decks for the consumers: format `dealer.v1`, rng, Trip constants, `modulePolicy` (from `DEAL_POLICY`), 6 pools, 89 cases, coverage of `military-v1` under both policies. 293,247 bytes. Source `src/rules/dealer-fixture.ts` (under `src/` so `nest build` compiles it for `scripts/write-contracts.mjs`; `test/dealer-cases.ts` re-exports it). No route, no migration. XU2 is the authority for Unity; the C# cross-check below is extra evidence |
| 5.I | Slice B5: staff Trip-coverage route over the content store (brief `../docs/briefs/cross-repo-catalog-dealer.md`, B5 and Refresh 2026-10-29) | **Done (local, uncommitted)** 2026-11-02, awaiting independent review | **API 0.8.0, staff-only, no change for the game.** `POST /v1/admin/content/:module/trip-coverage`, strict body `{ itemIds?: string[] }` (absent body = `{}`; at most 2000 ids, each 1-64 chars), 200 `{ module, policy, flightsPerTrip, ranks: [{ rank, dealable }] }` in RANKS order, computed by B3's `tripCoverage` over APPROVED `content_items` in natural id order (`ContentService.tripCoverage`; pure row mapping in `src/content/deal-items.ts`, photo = `data.sourceFile`, trimmed NFC; blank = not dealable via `dealablePool`). Unmapped module: 404 `not_found`. New error code `unknown_item_ids` (422; an id not stored for the module in any status; a known non-approved id is just not counted). Same class-level staff guard. No migration, no `dealer.ts` change, sample-trip route not built. **Choices not settled by the brief (for review):** (1) a repeated id counts once (not 400); the 2000 limit applies to the raw array. (2) A module with a mapping but no `DEAL_POLICY` is 404 `not_found`, matching `DealNotSupportedError`'s "the server does not deal it"; unreachable today (only Military has a mapping and it has a policy). (3) Ids are capped at 64 chars because the global JSON limit is 16 KB, which 2000 ids would exceed: `app.setup.ts` parametrises the xlsx pre-auth reader (`staffBodyReader`) and mounts a 160 KB `express.json` on this path the same way, so the body is read only after the token is verified as staff; no or malformed Bearer falls through to the global 16 KB parser (413 above it), junk token 401, non-staff 403. (4) The 422 message names up to 10 unknown ids; no structured field. (5) Order of checks: auth, size (413), body validation (400, then 415 for a non-empty non-JSON body, since its itemIds would otherwise be ignored), then the module 404 (documented in openapi). (6) `rowToDealItem` drops a malformed approved row (bad rank, wrong not 3 non-empty strings, non-string answer or sourceFile) and the service logs a warning with the count; no response field. `test/api.test.ts` route count 18 to 19; `test/deal-items.test.ts` (unit, in `vitest.config.ts`) |
| 5.J | Slice T4 of 5.C: content documents and the pull manifest (`docs/design/trips-awards-logbook.md`, "T4 as built") | **Done (local, uncommitted)** 2026-11-02, awaiting independent review | **API 0.9.0: two routes built, nothing else changes for the game.** `GET /v1/content/manifest` (Unity `ManifestWire`/`ModuleWire` + `documents[]`; `enabled` always true, `contentVersion`/`assetBundleUrl` null; `version` = `m-` + 16 hex of a hash over the sorted (name, version, sha256) list and the module entries, so identical on every instance and restart; strong ETag, 304 on `If-None-Match`, `Cache-Control: no-cache`; `generatedAtUtc` = newest document `created_at`, not the request time) and `GET /v1/content/documents/{name}/{version}` (ETag = sha256, `private, max-age=31536000, immutable`, 304; unknown name/version/malformed version 404). Signed-in only (U11), under the version gate and the rate limiter. Migration `0011_content_documents` (generated; the immutability trigger is hand-appended to the file). **Bytes:** canonical JSON rebuilt from jsonb (`src/content/documents/canonical.ts`: UTF-8, keys sorted at every depth, no whitespace, integers only), digest and length stored at insert and re-checked at every read (mismatch = 500, never served). **Seed (decision, replaces "one migration-time import"):** `seedContentDocuments`, idempotent, one transaction under an advisory lock, runs at every start and after each successful content import; a name with any row is never touched, inserts are ON CONFLICT DO NOTHING; `field-awards` v1 and `aircraft-tags` v1 come from the code constants whenever missing (golden digest test); `clipper-cards` v1 is sealed only when Military items exist, so a fresh database gets it at the first import and an existing one at the first start. `catalogInForce(tx)` reads the highest valid `field-awards` / `aircraft-tags`; recorded `catalog_version` = the field-awards version applied; a bad newest row is skipped with an error log. Document-body validators (strict zod + 28 ids once, metric = id's own metric, integer targets) guard it. Tests: `test/content-documents.test.ts` (31, unit), `test/content-documents.e2e.test.ts` (33, e2e), one in `openapi.e2e`, parity lists, route count 19 to 21. **Review fixes 2026-11-02:** seeds are per-name savepoints and an over-limit Military item is skipped (counts in the row `note`); one "in force" selection (`documentInForce`, memoised per (name, version, sha256), walks to an older row only on failure) serves both the manifest and `catalogInForce`; no valid document yet is a retryable 503 `service_unavailable`; the manifest never fails because a seed failed. **T6 must remember:** a clipper-cards v1 sealed from a small or trial set stays incomplete until a publish; Card consumers need a fallback for a key not in the document; clients verify `sha256` against the manifest. Choices not settled by the spec are listed in the design doc (nine, none a user ruling). Next: independent review, then T5 (Logbook) |
| 5.K | Slice T5 of 5.C: the Pilot Logbook (`docs/design/trips-awards-logbook.md`, "T5 as built") | **Done (local, uncommitted)** 2026-11-02, awaiting independent review | **API 0.10.0: one route built, `x-planned` gone, nothing else changes for the game (no Progress or UGS-copy change, U1 untouched).** `GET /v1/me/logbook`: `recentTrips` (20 newest completed), `daily`, `lifetime`, `counters`, every Clipper Card, and all 28 Field Awards = catalog in force x stored earned rows. One REPEATABLE READ, READ ONLY transaction: no lock, no write, nothing bumped; `earned`/`earnedAt` come only from `player_field_awards` (a raised target reads earned with `current < target`; a lowered one reads unearned until the next completion, ASSUMPTION test). **Freshness (user ruling 2026-10-29 (1)):** migration `0012_logbook_version` (generated; `players.logbook_version integer NOT NULL DEFAULT 1`, CHECK >= 1) bumped by `PlayerBalance.update` through the new `Step.logbook` flag, inside the same single UPDATE (or a lone UPDATE touching neither `version` nor `updated_at` and enqueuing nothing), so a completion that pays no hint and resets no streak raises `logbook_version` and not `players.version`. Bumps: a banked Round (the daily log moves), a first-time `complete`, the lazy completion inside `POST /v1/trips`. No bump: replays and concurrent completes, abandon (any kind), open, issue, hint, refused result, shop, Active Rank, link, reads. **ETag** `"lb-"` + 32 hex of SHA-256 over `[format, player id, created_at, logbook_version, field-awards version in force, aircraft-tags version in force]`, so a publish changes it with no player write, and a deleted-and-recreated account or another player never shares a tag; no response field depends on the clock (tested). `If-None-Match` exact/weak/list/`*` gives 304; `Cache-Control: private, no-cache` (200 and 304; errors stay `no-store`). 404 `player_not_found` before `PUT /v1/me`; 503 via `catalogInForce` while unseeded (returned, not thrown, so the pooled connection survives); 426/429 from the shared guards. Size: 20 Trips, 28 awards, one record per Card held (bounded by content: 23 commercial + the Military answers, about 8 KB today, document cap 5,000). Cards come from stored rows only, so a key no `clipper-cards` document names still appears. `DatabaseService.withTransaction` takes an optional transaction config. Tests: `test/logbook.e2e.test.ts` (26: 401/404/503/426/429, the empty shape, no-write/no-lock, tag per write incl. the Progress-only writes, no-hint completion, lazy completion, concurrent completes, cross-player and recreated-account tags, catalog publishes and an invalid newest row, raised/lowered targets, unknown Card key, 20-row bound, a seeded history re-derived with the pure rules and SQL aggregates, concurrent-snapshot coherence, schema), `test/logbook.test.ts` (unit: builders, ETag inputs, the read path writes and locks nothing), one in `openapi.e2e` (real response, 304 headers, strict schema), a balance-guard case, route count 21 to 22. Choices not settled by the spec are listed in the design doc (eleven, none a user ruling). **Wave-review fixes (2026-11-02):** the "consistent snapshot" e2e is deterministic (a read before, each completion gated on a fresh read and overlapped with reads, reads until 3 Trips are seen; 10/10 runs green); the Logbook sends `Vary: Authorization`; `ifNoneMatchHits` moved to `src/common/http-cache.ts`. Next: independent review of T5 and T6 together |
| 5.L | Slice T6 of 5.C: admin edit and publish of the documents (`docs/design/trips-awards-logbook.md`, "T6 as built") | **Done (local, uncommitted)** 2026-11-02, awaiting independent review with T5 (one wave) | **API 0.11.0: five staff-only routes, no change for the game's own calls.** `GET /v1/admin/content/documents`, `GET` and `PATCH /v1/admin/content/documents/{name}/draft`, `POST .../draft/discard`, `POST .../publish` (same guards as `ContentController`: `@StaffOnly`, `@SkipClientVersion`; actor = the verified principal only). Migration `0013_content_drafts_and_publish` (generated; `content_drafts`, and `admin_audit_action_check` + `content_publish`; TS list, schema literal and S5 parity updated; second `db:generate`: no changes). **Draft = a mutable overlay** on the version in force (Field Award `title`/`criteria`/`target`/`hidden`; Card `name`; a Card's tag list), one row per name with a revision (`draftVersion`, no row = 0); published rows stay immutable. Edit, discard and publish of a name run under a per-name advisory lock; a stale `draftVersion` is 409 `version_conflict` and nothing changes. **Publish** (one transaction): the T4 validators run on the preview first (422 `content_invalid`; an unchanged draft is 409 `nothing_to_publish`), then the next version is inserted through `document-store.ts`, exactly one `content_publish` audit row is written (principal, changes, digest, note) and the draft is reset. `clipper-cards` is rebuilt from the approved Military content at publish time, so a v1 sealed from a small set catches up with one publish. Proven: an edit is invisible to players until publish; a publish changes the manifest version, `catalogInForce` and the Logbook ETag with no player write; later completions record the new `catalog_version`; earned awards never un-earn; old completions replay unchanged; concurrent edits and publishes (one winner, one row, one audit row; no lost edit); a rejected publish writes nothing; another process's memo stays correct. Tests: `test/content-publish.e2e.test.ts` (45), `test/content-publish.test.ts` (21, unit), one in `openapi.e2e` (real responses validate), route count 22 to 27. The `x-planned` loop in the parity test is still vacuous (nothing is planned); kept on purpose and labelled as such. New error codes: `version_conflict`, `nothing_to_publish`, `content_invalid`. **Follow-ups, not built:** Remote Config pointer and kill switches; re-importing a later Field Awards sheet through plan, confirm and apply; website admin screens (they must call these routes with the staff member's token and `X-Client: web`, and handle 409 by re-reading the draft); Unity must pull the new documents through the manifest and apply `catalogVersion`/targets (an earned award can read `earned: true` with `current < target`); moving the commercial `aircraftKey` gate to the `clipper-cards` document. **Wave-review fixes (2026-11-02):** removing a client-supplied tag needs `acknowledgeClientTagRemoval` (recorded in the change and the audit row); the draft keeps every editor and discarder in its `history` (no schema change) and a publish copies `editors` and `history` into the audit `detail`; a `clipper-cards` publish that removes a Card needs `acknowledgeCardRemoval` (422 `content_invalid` otherwise, recorded in the audit row); a publish takes the seed lock (a publish racing the seed wrote a duplicate of v1); `list` and `GET draft` read one snapshot; `seedContentDocuments` no longer reports a name that was not inserted. Choices not settled by the spec (twelve, none a user ruling) are in the design doc. Next: independent review of T5 and T6 together |
| 5.M | Slice A1: staff edit, retire and restore of content items | **Done** 2026-11-03 (wave A) | `PATCH /v1/admin/content/:module/items/:id` (strict `{ version, rank?, data? }`, shared `validatePayload` with the importer, field diff, 409 `version_conflict`, natural key kept non-blank and unique via `planImport`), `POST .../retire` and `.../restore` (restore allowed by the user ruling of 2026-11-03). One transaction under the module advisory lock shared with import apply (busy 409 `import_in_progress`); refusals returned, not thrown. Audit actions `content_edit`, `content_retire`, `content_restore` (migration `0015_content_item_edit_audit`). `card_key` never changes on an edit; a legacy NULL key is frozen from the pre-edit answer. Review fixes: a client sheet replays only when no staff write followed its receipt (database-clock stamps read after the module lock, compared in SQL at microsecond precision), so re-uploading the sheet restores the client's data |
| 5.N | Slice A2: re-import a Field Awards sheet into the `field-awards` draft | **Done** 2026-11-03 (wave A) | `POST /v1/admin/content/documents/field-awards/imports` (`?dryRun=true` / `?confirm=<planHash>`; same 5 MB body reader and unzip guards as content imports; upload kept in the BlobStore at `imports/field-awards/<sha256>.xlsx`). Rows match awards by catalog name (never guessed); title, criteria, target and `thresholdCell` copied verbatim; writes go through the draft path (history entry `import` + file sha256). Review fixes: the import (only) advances `thresholdCell`; a changed cell that is not one whole number is a **warning** that writes the cell, keeps the target and flags `targetNeedsRuling`; every expected refusal in the content-admin service keeps its pooled connection (`ExpectedRollback`) |
| 5.O | Slice I1: Airport Spotter importer | **Done** 2026-11-03 (wave A) | Mapping `src/content/modules/airport-spotter.ts`: 45 questions (Trainee 4, First Officer 15, Captain 10, Check Airman 14, Chief Pilot 2), ids `apt-a<N>`, natural key = corrected file name, payload `{ answer, wrong[3], sourceFile }`, codes upper-cased three-letter IATA. Unity's seven corrections (user ruling 2026-11-03) are a data-driven table guarded on row, correct airport and original value, each reported as a warning. Matches Unity's `airport_questions.json` on all 45 rows. No deal policy yet (trip-coverage 404), no Card key. The delivered sheet is 13 MB (embedded photos) and exceeds the 5 MB upload cap: re-save without photos, or raise the cap (open) |
| 5.P | Slice I2: Runway Identifier importer | **Parked** 2026-11-03 | The real sheet cannot import under the current rules: 477 of 499 rows have no photo file name, 77 codes appear twice (44 identical, 33 differing), 201 rows say "Check Pilot". Needs user rulings (key, "Check Pilot", photo-less rows); client questions in `docs/design/releases-and-dealing.md` §10 |
| 5.Q | Releases, photos, server dealing and answer checks for all eight modules | **Designed, not built** (2026-11-03) | [design/releases-and-dealing.md](design/releases-and-dealing.md): Bunny-backed snapshots and photos (built against the memory fake until sign-off), dealing from Postgres rows, one Flight per Round with its answer, per-module plan and transfer order, slices R0–R4, P1–P2, M-*. Waves B1–B5. Image storage and delivery decided in [adr/ADR-0001](adr/ADR-0001-image-storage-and-delivery.md). Open: Q-U9, Q-U10, Q-U11 |
| 5.R | Media pipeline and CDN delivery (Backend ADR-0001) | **Planned, approved** (2026-11-03); **API 0.18.0** 2026-11-04: guest read `GET /v1/public/media`; **API 0.19.0** 2026-11-04: rights statement v1 on upload, owner-only file uploads and `PUT .../rights`, publish needs a v1 statement, staff-only description, migration 0019 (incl. `media_imports`) (plan `docs/plans/media-rights-and-public.md` Waves P and R; **Wave I built** 2026-11-04: `npm run media:import` imports website D1 proposals (dry run by default; `--yes` only with `BLOB_STORE=bunny`; not yet run against a real store); **API 0.17.0** 2026-11-04 (from the website's media plan review): `creditRequired` changes are admin-only on licence edit (bug fix; the contract always said so) and `GET /v1/admin/media?pending=true` lists published items with a draft ahead; **Phase 0 done** (R-a, R-b, R-c) and **T0-T7 and R-d done** 2026-11-03, reviewed and pushed (API 0.16.0: every media route built, incl. signed 24 h links and `GET /v1/media`); **T8 docs done** 2026-11-03 (README env table, ARCHITECTURE "File storage", design doc §2 cross-references); next T10 live Bunny setup (needs user sign-off), then Wave B T9 (`ImageRef` on dealt Trips and Rounds) and releases freezing media versions | **R-a:** migration `0016_account_roles` (`account_roles`, PK (principal, role) = the guard's lookup index; five `role_*` audit actions; `ACCOUNT_ROLES`/`ROLE_STATES` + S5 parity), `src/auth/roles.ts` (`@Roles`, `RolesGuard`, `RolesService`, `@CallerRoles`), every `@StaffOnly` route now `@Roles("admin")` (incl. the pre-auth upload readers, `roleBodyReader`), `STAFF_EMAILS` and `src/auth/staff.ts` removed, `GET /v1/admin/me` adds `roles` (still admin-only). Tests seed roles with `test/roles-helpers.ts`; new `test/roles.test.ts` (unit) and `test/roles.e2e.test.ts`. [plans/media-pipeline.md](plans/media-pipeline.md): Phase 0 roles (R-a `account_roles` + guard, migration 0016; R-b registration and decisions; R-c `roles:grant`), then T0 contract (`x-planned`), T1 sniffer + CDN signer, T2 migration 0017, T3 upload, T4 versions/licence/publish, T5 staff read with preview links, T6 item link, T7 website batch read, T8 docs, T10 live Bunny setup (sign-off). Checkpoints A–C, each reviewed, committed and pushed |
| 5.2+ | Follow-ups (not started) | — | Website admin integration; first `bunny:check` against the real zone (needs sign-off and the zone password). Releases, photos, answer checks and the other modules' importers moved to 5.Q |

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

| # | Job | State | Notes |
|---|---|---|---|
| 6.1 | Database clock for Round timing across instances (slice A3) | **Done** 2026-11-03 (wave A) | Every player write path reads one `clock_timestamp()` instant after the player lock (`src/database/clock.ts`; `PlayerBalance.update` exposes it as `locked.now`) and uses it for every judgement and stored timestamp; controllers no longer pass `new Date()`. Test-only skew seam refused when `APP_ENV` or `NODE_ENV` is production. Review fix: the UGS mirror queues claim, lease and back off on the database clock, one reading per statement (index-friendly) |
| 6.2 | Shared rate-limit store (slice A4) | **Done** 2026-11-03 (wave A) | Postgres `@nestjs/throttler` storage (`src/platform/pg-throttler-storage.ts`, migration `0014_rate_limit_hits`: table + `rate_limit_increment`, an exact port of the 6.7.1 sliding window on the database clock; sha256 keys). `RATE_LIMIT_STORE=postgres` (default) or `memory`. Own pool (`RATE_LIMIT_POOL_MAX`, default 3) with short timeouts; per-key serialisation and a local "refused until" cache; fail-open to the in-memory store on a database failure, warning every 5 min while degraded, readiness detail `rateLimit: "degraded"` (still 200); budgeted cleanup. 429 shape unchanged |


Still open: choose host + managed Postgres (needs sign-off), SSL/pool sizing, backups/PITR, monitoring,
deploy runbook.

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
  `STAFF_EMAILS` (the website's rule). Never a client-supplied role. **Superseded 2026-11-03 by role-based access
  ([ADR-0002](adr/ADR-0002-role-based-access.md)); `STAFF_EMAILS` is retired.** The "never a client-supplied role" part stands.
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
- 2026-10-29 (user), after the T3 review:
  - (1) **Logbook freshness uses its own `logbookVersion`**, which T5 builds. It rises whenever Trips, Cards or Field Awards change and is served as the Logbook ETag. `players.version` keeps its U2 meaning, so a completion that pays no hint and resets no streak does not bump it.
  - (2) **Lazy completion of full segments is accepted.** A full segment is completed at the next `POST /v1/trips` or `complete`, with no background job and no completion on expiry.
- 2026-10-29 (user), on the website's question relayed by the docs session: **web callers send `X-Client: web`.**
  - The client version gate skips a request whose `X-Client` is exactly `web` (trimmed, any case).
  - The app keeps sending `X-Client-Version`, and a missing build number still counts as outdated (426).
  - It is a compatibility label, not a credential: the Firebase token is verified as usual.
  - The website's server-side calls (W6 `GET /v1/me/progress`) must send it.
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
  mirror) uses `withLiveStreak`; a reused Idempotency-Key with another module is 422 `idempotency_key_reused` (this compared the module
  only; commit eccc0c7 widened it to four fields and the user ruled it on 2026-11-02, see Decisions). The Military
  `card_key` stays a runtime freeze (importer on create, first use for older rows); the alternative is a backfill migration that
  fills `card_key` for existing rows once. Spec ambiguities are `ASSUMPTION:` tests (A2, A6, A8, A9, the interim `trip_full`
  block, defensive `trip_expired`, the runtime freeze).
- 2026-10-29 (T3, implementer's choices, for review; none is a user ruling yet): (1) `complete` is idempotent by reading its answer back
  from the tables (Cards by `first_trip_id`, awards by `trip_id`, the Trip hint from the ledger), so a replay can never differ from the
  first answer. (2) `POST /v1/trips` completes a full open segment in its own transaction and does not return that segment's lists
  (C1: the app calls `complete`, a replay). (3) A partial, expired segment answers `complete` with 410 `trip_expired` (A21). (4) The
  summary `localDate` is the completion day (A22). (5) Cards are listed by key, awards in catalog order (A23). (6) The two new tables
  have no foreign key to `trips` (C4). (7) The catalog and tag table come from code constants through `catalogInForce()` until T4; the
  recorded `catalog_version` is 1.
- 2026-10-29 (user, from the S3 review): the UGS copy names its owner. Snapshot `schemaVersion` 2 adds `uid` (the
  Firebase uid); the game uses a copy only when `uid` is the signed-in user, and compares `version` only between copies
  of one owner. Reason: after a link move or an erase + re-link, the UGS item can hold the previous owner's copy (with
  a higher version) until the worker rewrites it.
- 2026-11-02 (user): **D-1 amended: the game orders copies by `(version, evaluatedAt)`.** `version` orders stored changes;
  `evaluatedAt` orders time-derived changes such as lazy Trip expiry at one version. Consequences, all ruled or directed
  the same day: (a) the UGS copy is `schemaVersion` 3 with `evaluatedAt` required (no real copy of an earlier schema was
  ever written, UGS has never been contacted, so there is no legacy-copy rule); (b) `evaluatedAt` comes from the database
  clock, never a process clock (the S7 `ugs_budget` precedent: instances' clocks can disagree), and the same instant
  judges lazy Trip expiry; (c) API 0.7.0.
- 2026-11-02 (user): **U14 narrowed.** The same Idempotency-Key replays only when module, localDate, utcOffsetMinutes and
  contentVersion all equal the stored opening (`flightCount` is fixed at 10); otherwise 422 `idempotency_key_reused`. The
  comparison precedes date freshness, so an unchanged retry still replays after midnight.
- 2026-11-02 (user): **the "one slice at a time, no parallel worktree" ruling of 2026-10-29 is removed.** Slices may run in
  parallel in separate worktrees. The T2 → … → T6 order in that entry now only records dependencies, not a queue. One
  session per repo still holds; parallel slices are subagents of this session.
- 2026-11-02 (user): **slices are grouped into waves.** One independent review covers a whole wave of edits, then it is
  committed, instead of one review and commit per slice (set for T5 and T6). Keep separate commits per slice when the
  wave's diff splits cleanly.
- 2026-10-29 (implementer's choices in eccc0c7, NOT user rulings; the commit came from Codex outside the project workflow and
  was independently reviewed afterwards): (1) completed-Flight result replays pass the player through `withLiveStreak`, so an
  expired Trip reads 0 in both `progress` and `trip`; (2) a replayed result's `progress` is current, not byte-identical to
  the first answer; (3) `evaluatedAt` was added to Progress and the UGS copy, optional on old copies (superseded by the two
  user rulings above: required, database clock, schemaVersion 3); (4) lazy expiry stays read-only: no write-on-read;
  (5) the changed-body message of `idempotency_key_reused`. The ordering and the four-field key rule it proposed are now ruled.

- 2026-11-02 (T5, implementer's choices, for review; none is a user ruling): (1) `logbook_version` is a column on `players`, bumped by `PlayerBalance.update` (`Step.logbook`), not a separate table. (2) Abandon does not bump: the Logbook shows completed segments and counters only, so an abandon changes nothing it returns (the ruling's "Trips ... change" read as "what the Logbook returns"). (3) A banked Round does bump: `daily` is in the response. (4) `Cache-Control: private, no-cache` rather than the manifest's `no-cache`. (5) The ETag folds in the player id and `created_at` so a recreated account (counter back at 1) never reuses a tag. (6) `earned` is the stored fact, so a lowered target reads unearned until the next completion. (7) Cards come from stored rows only and carry the contract's five fields, with no display name and no join to `clipper-cards`; there is no row cap, the bound is the content. (8) `recentTrips[].localDate` is the completion day.
- 2026-11-02 (T6, implementer's choices, for review; none is a user ruling): (1) a draft is a mutable overlay in `content_drafts` (one row per document name, revision-checked), not a copy of the document, so it never goes stale against a newer version; (2) the editors' version check is `draftVersion` in the body (stale = 409 `version_conflict`), per document, not per field or award; (3) three new error codes: `version_conflict`, `nothing_to_publish`, `content_invalid`; (4) a publish of an unchanged draft is the defined refusal 409 `nothing_to_publish`; (5) `clipper-cards` is always rebuilt from the approved Military content at publish time (only names are edited), and a staff-edited name outranks the published name, which outranks the content's; (6) a tag a staff member adds is `provisional`, an existing tag keeps its source (ASSUMPTION); (7) `thresholdCell` is not editable and can disagree with an edited `target`; (8) U10 is met by recorded title/criteria edits (the audit row holds old and new text); (9) the audit row's `createdAt` is the process clock like `content_import`, the document's `created_at` the database clock.

- 2026-11-03 (user): **admin restore of a retired content item is allowed** (amends 2026-10-28 "only a client sheet returns it to approved"). A staff restore, like an edit or retire, ends the replay of the latest client sheet.
- 2026-11-03 (user): **importers apply Unity's corrections.** Airport Spotter applies exactly the corrections Unity's importer applies, each as a warning and only while the sheet still holds the original value. Runway Identifier follows Unity where Unity decided (only the `,jpg` typo); its other blockers wait for rulings.
- 2026-11-03 (user), Wave B: (1) reveal **one Flight at a time** with its correct answer (consistency checks, not anti-cheat) and **plan every module onto the backend** as its content transfers; (2) **release packages and images go to Bunny** (memory fake until sign-off); (3) **Military requires server-dealt Trips** from its first release (no deployed build), a **rollback does not cancel open Trips**, **staff choose the items** of a release. See `docs/design/releases-and-dealing.md` §R.
- 2026-11-03 (user), image delivery (Backend ADR-0001, accepted): game images live in the shared zone at `backend/content/photos/<sha256>.<ext>` and are described by a backend media table (path, hash, size, type, dimensions, version, licence fields incl. a credit-required flag; never a URL); staff upload through the backend; upload stores, publish makes live; delivered by a Bunny pull zone with zone-wide token auth, one HS256 signature per file, 24 h links and device cache, no IP binding, key only in the backend env; an Edge Rule blocks everything outside `/backend/content/photos/`; Trip open sends all ten links, each Round issue re-sends its own; the website reads image records from the backend; Plane of the Day is the next slice on top. Live Bunny changes still need sign-off and `bunny:check`.
- 2026-11-03 (user), **role-based access (Backend ADR-0002, accepted; supersedes the 2026-10-28 `STAFF_EMAILS` staff rule)**: privileges come only from the backend `account_roles` table keyed by principal; one Firebase identity (signed in through Unity Auth `oidc-firebase`) holds a set of roles; `player` at signup, `photographer` by request + admin approval, `admin` only by grant or the audited one-time `roles:grant` command; guards read roles per request; photographer/admin need a verified email; photographers manage only their own uploads, admins publish, withdraw, link and decide roles. Media publish needs a licence name and, when `creditRequired`, a credit (source URL optional). The media contract is approved as proposed.
- 2026-11-03 (user, after the plan gate for R-b/R-c/T0/T2): a published image and its credit stay live until an admin publishes a change (draft vs published version, licence per version); a photographer request records the verified email for admins only (cleared by `DELETE /v1/me`); `player` is informational and not revocable in this wave; roles and audit rows survive `DELETE /v1/me`; self-revoke allowed while another admin remains; `roles:grant` only `admin`, only with zero active admins, `--yes`. Plan gate: `senior-lead` and `backend-expert` approved with changes, applied in `docs/plans/media-pipeline.md` and ADR-0002.
- 2026-11-03 (user): **no git worktrees or side branches**; work on `main` and push to `origin` after each verified piece. (Wave A was built in worktrees on the E: clone during the H: disk episode, then integrated and pushed.)
- 2026-11-03 (R-a, implementer's choices, for review; none is a user ruling): (1) `GET /v1/admin/me` stays admin-only (who could call it before = staff = now admins); a photographer gets 403 there; `staff: true` is kept and `roles` added (required in the schema, always present). (2) Several roles in `@Roles(a, b)` are any-of; `admin` satisfies `photographer` but not `player`. (3) "Verified email" = `email_verified === true` AND a non-empty email claim (a token with the flag but no email is refused, as before). (4) The guard's index is the primary key (principal, role); no separate index. (5) `requested_at` defaults to the database's `now()`; R-b writes should stamp with `databaseClock()`. No CHECK ties `decided_at`/`decided_by` to the state, so R-b's `player` issue at signup is not constrained yet. (6) The 403 message is "Requires the admin role." (was "Staff only."). (7) A leftover `STAFF_EMAILS` in an environment is silently ignored (zod strips unknown keys), not a startup error. (8) `src/auth/staff.ts` and `test/staff.test.ts` deleted.
- 2026-11-03 (wave A, implementer's choices, for review; none is a user ruling): A1 payload faults are 422 `import_invalid` (no new code), `data` is a full replacement, validation precedes the version check; A2 matches rows by award name, lists only changed awards, the sheet wins over earlier draft edits, an unreadable changed cell (fractions, zero, out of range too) is a warning with `targetNeedsRuling`; A3 removes `now` from service and PlayerBalance signatures, `clock_timestamp()` truncated to ms for player paths; A4 sliding-window parity incl. `hit_expiries timestamptz[]`, fail-open, the local refusal cache only for `blockDuration` 0; I1 ids `apt-a<N>` (Unity's are `airport-apt-<iata>-<n>`; join on the corrected file name), codes upper-cased on write, airport names and photographer not stored.

## Open questions for Josh

See README "Open questions". Also: Apple's App Store guidelines generally require Sign in with Apple
when Google sign-in is offered; the project rule currently allows only email/password and Google.

## Verification log

- 2026-11-04 (Wave I follow-up, user ruling via the website: keep D1 `title`, `factualSource`, `rightsEvidence`; lead review): `npm run typecheck` clean; `npm test` 748 passed; all 8 media e2e files 208 passed (`test/media-import.e2e.test.ts` 36). Title (160) and facts source (600) become labelled description lines with whitespace runs collapsed; rights evidence (2400) is kept verbatim in the `media_import` audit detail, not the description; over a limit refuses that entry. Plan wording fixed: the manifest's `own` is not the D1 spelling (`owner`), the website's export maps it; whole-run refusals listed. No API change.

- 2026-11-04 (Wave I, D1 import command, after one independent review and its fixes; no API change): `npm run typecheck` clean; `npm run build` ok; `npm test` 748 passed (34 files); `npm run test:e2e` 884 passed in 31 files, plus `test/roles-grant.e2e.test.ts` 14 passed after the isolation fix below (new `test/media-import.e2e.test.ts`, 32 tests: dry run writes nothing, apply, re-run, a forced claim race that runs the lost-claim path, role revoked or blocked mid-run, path/symlink/size/sha/type/date/description/credit refusals, CLI spawns incl. `--yes` refused with the memory and none stores, and an imported item published end to end after the owner's v1 statement and a licence). Review fixes: the user-ruled audit note restored; blank credit treated as absent; `FOR SHARE` on the in-transaction role re-check; bundle files opened with `O_NOFOLLOW` where available and read with a cap. Admin owners are accepted (`holds()`, ADR-0002), recorded in the plan. Test isolation: the developer `.env` now holds live Bunny settings (T10), so `vitest.e2e.config.ts` strips `BUNNY_*`, `BLOB_STORE` and `TRUST_PROXY` and forces the memory store, and the `roles:grant` CLI tests run the script from the temp directory so it cannot read `.env`. No Bunny contact.

- 2026-11-04 (API 0.19.0, Wave R, after one independent review and its fixes): `npm run typecheck` clean; `npm run db:generate` no changes (0019 has a hand-appended `NOT VALID` on the re-added publishable CHECK, with a SQL comment); `npm run contracts:write` unchanged; `npm test` 748 passed (34 files); `npm run test:e2e` 859 passed (31 files; new `test/media-rights.e2e.test.ts`, `test/migration-0019.e2e.test.ts`; the clock fix 9ab0565 makes content-documents pass at night). The reviewer re-ran drizzle-kit against a scratch copy, matched the 0019 snapshot chain and checked `convalidated = f` on the test database. Review fixes: leading and trailing control characters in a description are now refused, not trimmed away; a test for the eligible case (older published version, newer draft without a statement); test upload helpers no longer force the rights header; openapi wording. Deviation accepted: the publishable CHECK adds `rights_statement IS NOT NULL` (NULL IN (...) would pass a CHECK). Local only; no Bunny contact.

- 2026-11-04 (API 0.18.0, Wave P, after the plan gate (senior-lead, backend-expert) and one independent review): `npm run typecheck` clean; `npm run contracts:write` unchanged; `npm test` 748 passed (34 files); `npm run test:e2e` 826 of 830 passed (29 files; new `test/media-guest.e2e.test.ts`, 16 tests). Failures: the 3 clock-dependent `content-documents` tests (run at about 04:00 UTC, see the 0.17.0 entry) and `media-read` "is strict", whose hand-forged cursor was by chance the canonical cursor of another id (cursors are unsigned by design); that test now checks unparseable and non-canonical cursors and passes (16/16). Review fixes: 503 on the guest route, auth and version-gate exemption wording in openapi and README. Local only; no Bunny contact.

- 2026-11-04 (API 0.17.0, after one independent review; tiny change, no plan gate): `npm run typecheck` clean; `npm run contracts:write` unchanged; `npm test` 748 passed (34 files); `npm run test:e2e` 811 of 814 passed (28 files). New tests in `test/media-versions.e2e.test.ts` (photographer 403 on a `creditRequired` change, stored value a no-op, 404/409 before 403) and `test/media-read.e2e.test.ts` (`?pending=true` set, owner scoping, paging, cursor binding, bad values); four existing tests that had a photographer turn credit off now use an admin. The 3 failures are in `test/content-documents.e2e.test.ts` (`catalogInForce` tests) and are unrelated: they expect no `red-eye-special` award, which is due for a Trip completed 22:00-05:00 local time, and the run was at 03:45 UTC. Clock-dependent test, open follow-up: pin the Trip's completion time in those tests. Local only; no Bunny contact.

- 2026-11-03 (wave T5-T7, after one independent review): fresh test databases; `npm run typecheck` clean; `npm run db:generate` no changes; `npm run contracts:write` unchanged; `npm test` 748 passed (34 files); `npm run test:e2e` 809 passed (28 files; new `test/media-read.e2e.test.ts`, `test/media-public.e2e.test.ts`, link tests in `test/content-items-edit.e2e.test.ts`). The reviewer re-derived Bunny's official token vector (`SecurityKey`, `/300kb.jpg`, 1598024587) with node crypto: it matches `computeCdnToken`. Accepted gap: no test captures logger output to prove the CDN key is never logged (no code path logs config or the key; config errors name variables only). Lead rulings: CDN host and key required in production (so `roles:grant` in production needs them too); no default host until T10; `BUNNY_STORAGE_PREFIX` must stay `backend/` while a CDN is set; any existing media item may be linked to a content item (readers only ever see published versions); the list cursor is opaque but unsigned (grants nothing). Local only; no Bunny contact.

- 2026-11-03 (wave R-d + T4, after one independent review and its fixes): fresh test databases; `npm run typecheck` clean; `npm run db:generate` no changes; `npm test` 742 passed (34 files; `test/typed-email.test.ts` registered, it was not running); `npm run test:e2e` 764 passed (26 files). New: `test/role-block-email.e2e.test.ts`, `test/media-versions.e2e.test.ts` (deterministic lock-queued races via `pg_locks`, including the in-transaction idempotency re-check), `test/migration-0018.e2e.test.ts` (0018 applied over rows seeded at 0017 in every role state). The `[Unhandled] integer out of range` log line is the deliberate overflow test at `test/api.test.ts:863`. Decisions: republish keeps a version's first `published_at`; an edit of a once-published (withdrawn) draft makes version + 1. Local only; MemoryBlobStore; no Bunny contact.

- 2026-11-03 (T3 media upload, after the review fixes): fresh test databases; `npm run typecheck` clean; `npm run db:generate` no changes; `npm test` 738 passed (33 files); `npm run test:e2e` 694 passed (23 files; 29 in `test/media.e2e.test.ts`, including a deterministic lost-race test held by an open pg transaction, a pool-leak check, rate limit before the body, exact-path mount, and database-clock timestamps). Against `MemoryBlobStore` only; no real Bunny contact. ASSUMPTION pinned by a test: a new version starts with `creditRequired = true`.

- 2026-11-03 (R-c `roles:grant` + T0 media contract, after the review fixes): fresh test databases; `npm run typecheck` clean; `npm run db:generate` no changes; `npm test` 738 passed (33 files); `npm run test:e2e` 665 passed (22 files), run twice, both clean. R-c: the script loads the server's own `loadConfig` (production TLS rules, no ssl options in `DATABASE_URL`), prints safe error fields and the parsed host only, refuses unless no active admin exists (checked under the role lock). T0: 9 `x-planned` media operations; PATCH requires `licence` and makes a new draft version when draft == published; the idempotency key is checked before the `revision` fence. Local only; no real Bunny or cloud contact.

- 2026-11-03 (flaky e2e, root cause): `content-items-edit.e2e` "lazy card_key freeze ... still replays" failed once in a full run. Cause: `test/fixtures.ts` `xlsx()` (write-excel-file) stamps the zip with the current time, so the same rows built across a second boundary hash differently and an intended replay became a new import (reproduced deterministically with a 2.1 s pause). Fix (test-only): `xlsx()` memoises by row content (equal rows give byte-identical files, copies returned) and the file reuses its `beforeEach` sheet. After: unit 738/738, e2e 653/653 on a fresh database. R-b + T2 (commits 4786489, 8a759c9): typecheck clean, `db:generate` no changes, unit 738, e2e 653 on fresh databases; reviewed by code-reviewer, findings fixed.

- 2026-11-03 (R-a roles guard, local, before review): `npm run typecheck` clean; `npm test` 699 passed (32 files; includes the concurrently added image-sniff/cdn-signer unit tests); `npm run test:e2e` against a fresh `airplane_games_ra_test` 607 passed (19 files), twice; second `db:generate`: no changes. Not proven: a real (non-emulator) token, the website's calls, any deployed database.

- 2026-11-03 (wave A: A1 item edit/retire/restore, A2 Field Awards sheet import, A3 database clock, A4 shared rate limits, I1 Airport Spotter importer; two independent reviews, all findings fixed): built in worktrees on the E: clone during the H: disk episode, integrated, then pushed. Final run on a freshly migrated `airplane_games_wavea_test`: typecheck clean, `db:generate` reports no schema changes, unit 650/650, e2e 595/595 (119 s), e2e repeated 595/595. Baseline before the wave: 588 unit / 508 e2e. Migrations 0014 (`rate_limit_hits` + `rate_limit_increment`) and 0015 (audit actions) were edited only before any commit (applied only to throwaway test databases, all dropped); the dev database never ran them. The real Airport Spotter sheet and the Unity pack cross-check ran (not skipped). Not verified: the 13 MB Airport Spotter sheet through the HTTP route (exceeds the 5 MB cap; tests use a copy re-saved without photos); any hosted or multi-host deployment of the shared limiter (two Nest apps on one database in e2e only).

- 2026-11-02 (UGS wave: token environment check, demo guard, script fixes; independent review done): a UGS setting with a `demo-` `FIREBASE_PROJECT_ID` is now refused at startup (not for `APP_ENV=test`, whose values are fake). **Found while adding it:** `vitest.e2e.config.ts` loaded `.env`, so e2e runs had the real UGS service account beside the demo project, and the worker autostarts with the real fetcher (2 s tick). The config now deletes every `UGS_*` from `.env`. Whether an earlier run sent anything to real UGS `development` is not known: the test database shows 0 attempts on its queued rows and no pace rows, which is not proof (nothing is logged for a success). Review also fixed: `stop()` in `ugs:check` throws, so the Trip cleanup runs; script diagnostics and stale UNVERIFIED wording. `upid:` in `aud` is reported, not enforced. Not done: Cloud Save delete, `production`, game sign-in. From PowerShell in `H:\Work\TheAviationArcade\Backend`: typecheck and build clean, `npm test` 588/588, `npm run test:e2e` 508/508, `ugs:check` dry run OK, the `stop()` path exercised with a missing token file (no request sent).

- 2026-11-02 (`ugs:check --live`, final run by the user against `development`, output pasted): 18/18. Sign-in through `oidc-firebase`, token verified, Player Auth admin,
  `providerId`, `externalId`, `PUT /v1/me` 201, `PUT /v1/me/ugs-link` 201, Cloud Save copy at version 1 after the link and version 2 after one banked Round, both with
  schemaVersion 3, the owner's uid and `evaluatedAt`. This confirms the Cloud Save read shape. Not proven: a sign-in from the game (the script exchanged the token itself), `production`,
  load or rate limits. The test user now has one player, one link and one abandoned Trip in the dev database.

- 2026-11-02 (`ugs:check --live`, second and third runs, by the user, after fixing the 403 on the dashboard): Player Auth admin answers; `providerId` =
  `oidc-firebase`; `externalId` = Firebase uid; `aud` has `idd`, `envName`, `envId`, `upid` entries and names `UGS_ENVIRONMENT_ID`. Both UNVERIFIED items are settled
  for one player from an exchanged token. Stopped at `PUT /v1/me` because no backend was running, so the link and copy steps are unproven. **Fix:** `verifyUgsToken` now
  requires an environment (from `aud` or top-level `envId`); none is 400 "no environment claim". Typecheck clean; `test/ugs.test.ts` 40/40. E2e and the full suite not run (shared test database, T6 session active).

- 2026-11-02 (`ugs:check --live`, first real UGS contact, run by the user against `development`, output pasted): the Firebase token was accepted by
  `oidc-firebase` (HTTP 200) and the UGS token passed `verifyUgsToken`. Claims seen: aud, exp, iat, idd, iss, jti, nbf, project_id, sign_in_provider, sub,
  token_type, version; `project_id` equals `UGS_PROJECT_ID`; `upid` and `envId` absent. So the project half of UNVERIFIED item 1 holds, but **the
  `envId` check in `verifyUgsToken` never fires on this token: the environment is not enforced at the top-level claim** (the script now reports whether `aud` names it).
  Player Auth admin answered 403, so UNVERIFIED item 2, the link and the Cloud Save copy are all still unproven. Exchanged token, so no game sign-in is proven.

- 2026-11-02 (T5+T6 wave review fixes, implementer's run): from PowerShell in `H:\Work\TheAviationArcade\Backend`. Changes: client-tag removal acknowledgement; draft `history` (editors and discards) copied into the
  publish audit `detail`, no schema change (0013 untouched); `acknowledgeCardRemoval` on a `clipper-cards` publish; publish takes the seed lock; `seedContentDocuments` reports only real inserts;
  `list`/`GET draft` in one REPEATABLE READ snapshot; `ifNoneMatchHits` to `src/common/http-cache.ts`; `Vary: Authorization` on the Logbook; the Logbook "consistent snapshot" e2e rewritten to be deterministic;
  openapi (still 0.11.0, unpublished), README-free, design doc, TASKS rows 5.K and 5.L. New tests: unit (5 in `content-publish.test.ts`), e2e (editors and discards, client-tag acknowledgement x3, publish over an invalid
  newest row, a clipper-cards publish leaving the Logbook ETag unchanged, a publish racing the seed x6 rounds, Card-removal acknowledgement). The race test found a real defect (a publish racing the seed wrote a duplicate of
  v1 as v2), fixed with the seed lock. Results: `npm run typecheck` clean; `npm test` 25 files, 587/587; `npm run db:migrate` up to date; `npm run test:e2e` 13 files, 508/508; `npm run build` clean;
  `npm run db:generate` "No schema changes, nothing to migrate"; `npm run contracts:write` no git diff. `test/logbook.e2e.test.ts` run alone 10 times: 10/10 green (26 tests each). No independent review yet.
- 2026-11-02 (5.1 UGS smoke check prepared, NOT run against UGS): `scripts/ugs-check.mjs`, `npm run ugs:check`. Without `--live` it checks the settings
  and prints the plan; `--live` needs the owner's sign-off, all `UGS_*` values and a Firebase token file. `.env.example` carries the project, environment
  and provider values, commented out. Role facts re-checked in the Unity docs: Player Auth admin needs the API enabled and scope `player_auth.users.get`;
  no page names the role for that scope. Results: `nest build` clean; `node --check` clean; with no settings, and with `--live` and no token file, it exits 1
  with "No request was sent"; with fake settings it prints the plan and exits 0. Unproven: every live step, including the Cloud Save read's `results[]` shape
  (taken from sibling endpoints) and whether the external-token call needs an Authorization header (the doc's sample shows one; sent without).

- 2026-11-02 (T6 admin edit and publish, API 0.11.0, implementer's run, before review): from PowerShell in `H:\Work\TheAviationArcade\Backend` (uppercase H), Postgres up.
  Changes: migration `0013_content_drafts_and_publish` (generated; `db:generate` run twice, the second "No schema changes, nothing to migrate"); `content_drafts`
  table, `content_publish` audit action (`ADMIN_AUDIT_ACTIONS`, `schema.ts`, `test/schema-parity.ts`); `src/content/documents/{drafts,draft-store,content-admin.service,content-admin.controller}.ts`;
  `nextDocumentVersion` in `document-store.ts`; `MAX_TARGET` exported; three error codes; openapi 0.11.0 (five routes, schemas, `VersionConflict` and `InvalidDraft` responses,
  `Error` enum); README, design doc ("T6 as built"), this file; `vitest.config.ts` (+ the unit file); `api.test.ts` route count 22 to 27; the parity test's x-planned test relabelled
  (it checks nothing while nothing is planned). Results: `npm run typecheck` clean; `npm test` 25 files, 582/582 (21 new in `test/content-publish.test.ts`); `npm run db:migrate`
  applied 0013; `npm run test:e2e` 13 files, 501/501 (45 new in `test/content-publish.e2e.test.ts`, one new in `openapi.e2e`); `npm run build` clean; `npm run contracts:write`
  rewrote both files with no git diff. Found by the tests: zod 4's `z.record(z.enum(...))` is exhaustive (every award id required), fixed with `z.partialRecord`; the contract
  schema for the draft with `body` cannot be an `allOf` of a closed object (written out instead). One earlier full e2e run had a failure in T5's
  `logbook.e2e.test.ts` "under concurrent completions ... one tag always names one body" (`expected 1 to be >= 2`, a timing-dependent distinct-tag count); it passed on rerun alone
  and in the final full run, and T6 touches nothing it reads; flagged for the T5/T6 review. Not run: nothing against a cloud; no independent review yet.
- 2026-11-02 (T5 Logbook, API 0.10.0, implementer's run, before review): from PowerShell in `H:\Work\TheAviationArcade\Backend` (Postgres up). Changes:
  migration `0012_logbook_version`; `Step.logbook` in `PlayerBalance`; `logbook: true` on the Round result, `complete` and the lazy completion in
  `POST /v1/trips`; `src/logbook/` (builders, service, controller, module); `CatalogInForce.tagsVersion`; `withTransaction(fn, config?)`;
  openapi 0.10.0 (x-planned removed, `PrivateNoCache`, `If-None-Match`/304 on the route); README, design doc, this file; test fixtures that build
  a `PlayerRow` gained `logbookVersion`. Results: `npm run typecheck` clean; `npm test` 24 files, 561/561; `npm run db:migrate` applied 0012;
  `npm run test:e2e` 12 files, 455/455 (26 in the new `logbook.e2e.test.ts`; the "integer out of range" Nest log line in that run comes from an
  older negative test, not from T5); `npm run build` clean; `npm run db:generate` (second run) "No schema changes, nothing to migrate";
  `npm run contracts:write` no git diff. No independent review yet. The first draft of the Logbook e2e failed on three assertions that expected no
  `ETag` on an error (Express adds a weak tag to every JSON body); fixed to assert that no Logbook tag is present.
- 2026-11-02 (T4 review fixes, implementer's run): from PowerShell in `H:\Work\TheAviationArcade\Backend`. Changes: per-name seed savepoints and skipped
  over-limit Military items (counts in the row note); one memoised "in force" selection (`documentInForce`) for the manifest and `catalogInForce`,
  walking to an older row only on failure; no valid document = retryable 503 `service_unavailable`; the manifest lists what exists and seeds
  only when the table is empty; the re-derivation test reads the catalog at the recorded `catalog_version`; openapi 503 text on `complete` and
  `POST /v1/trips`; docs. Results: `npm run typecheck` clean; `npm test` 23 files, 549/549; `npm run db:migrate` applied, no change to 0011;
  `npm run test:e2e` 11 files, 428/428 (6 new in `content-documents.e2e.test.ts`: over-limit items, only-oversize, savepoint isolation via a failing
  CHECK, empty table at manifest time, bad newest row agreeing in manifest and catalog, memoisation counter; the 503 test replaced the old
  throw test); `npm run build` clean; `npm run db:generate` "No schema changes, nothing to migrate"; `npm run contracts:write` no git diff. No
  independent review of these fixes.

- 2026-11-02 (T4 content documents and manifest, API 0.9.0, implementer's run, before review): from PowerShell in
  `H:\Work\TheAviationArcade\Backend` (uppercase H), Postgres on 5433 up. `npm run db:generate -- --name content_documents` produced
  `0011_content_documents` (trigger appended by hand; a second `db:generate`: "No schema changes, nothing to migrate");
  `npm run typecheck` clean; `npm test` 23 files, 549/549 (new `test/content-documents.test.ts`, 31); `npm run db:migrate` applied 0011 to the dev
  database, then "up to date"; `npm run test:e2e` 11 files, 422/422 (new `test/content-documents.e2e.test.ts`, 33, uses throwaway databases
  `airplane_games_seed_*_test` for fresh vs existing, concurrent seeds, two instances booting at once, and a fresh app whose first import seals
  clipper-cards v1); `npm run build` clean; `npm run contracts:write` rewrote both files with no git diff. Existing tests changed: `api.test.ts`
  (unauthenticated route count 19 to 21 and two path samples), `openapi.e2e` (+1 test: real manifest and documents validate against the spec),
  `schema-parity.ts` (+1 list), `trips.e2e` (one re-derivation test calls `catalogInForce(db)`), `vitest.config.ts` (+ the unit file). The replay and
  re-derivation tests are otherwise unchanged and green. First e2e run found one real defect: the platform test that starts the app on a dead
  database failed because the boot seed was fatal; the seed is now non-fatal with a background retry. Mutation check: removing the key sort from canonical.ts failed 5 unit tests (sorting, jsonb independence, escaping, digest, golden); restored, all green. Not run: nothing
  against a real cloud; no independent review yet. Unproven: behaviour when two instances with different clocks seed (the seed uses only the database
  clock and a lock, no process time).

- 2026-11-02 (B5 Trip-coverage route, API 0.8.0, implementer's run, before review): from PowerShell in
  `H:\Work\TheAviationArcade\Backend` (uppercase H), Postgres up. `npm run typecheck` clean; `npm test` 22 files, 518/518 (new `test/deal-items.test.ts`);
  `npm run test:e2e` 10 files, 388/388 (14 "trip coverage" tests and a 5-test "auth before the trip-coverage body" suite in
  `content.e2e.test.ts`, plus the staff-gate 401/403 loop covers the route; one early run failed only on `api.test.ts` route count
  18, bumped to 19, then green); `npm run build` clean;
  `npm run db:generate`: "No schema changes, nothing to migrate"; `npm run contracts:write` rewrote both files with no git diff.
  Coverage numbers are asserted against `contracts/dealer.v1.json` (military-v1, nearest-ranks entry) for the 31-row fixture sheet and,
  when `../docs/Military Airplane Identifier v1.xlsx` exists, the client's real sheet: all five ranks 10 (they agree). The lower-ranks
  entry (trainee 5) cannot be reached through the route, which always uses the module's own policy. The openapi parity test covers the
  new route and `unknown_item_ids` (it passed). Review fixes: pre-auth body read (junk token 401 and non-staff 403 before the body, no
  token over 16 KB 413, staff up to 160 KB, 413 above), 415 for a non-JSON body. Mutation check: removing `.sort(compareIds)` from
  `ContentService.tripCoverage` made the order test ("one photo, two answer keys", rows rewritten newest-first so a scan returns reverse
  id order; id order gives 3 at every rank, reverse gives 2) fail, the only failure; restored, all green. Not run: nothing against a real cloud; no independent review yet.

- 2026-11-02 (API 0.7.0, user rulings of the day): UGS copy `schemaVersion` 3 with `evaluatedAt` required; the legacy
  "pre-0.6.0 copy" wording and its test are gone (no real copy was ever written; nothing in `src/` reads `schemaVersion`
  from stored rows, it is only written). `evaluatedAt` is the database clock: `withLiveStreak(db, player)` now returns a
  `LivePlayer` and does one query per response (stamp `date_trunc('milliseconds', clock_timestamp())` and the open-segment
  expiry test in one statement), so stamp and judgement are one instant. `progressView(LivePlayer)` and
  `mirrorSnapshot(LivePlayer)` are pure and take the stamp from the row. The mirror worker calls `withLiveStreak` for each row
  (by code; the tick's `now` is no longer used for views). Its test proves the stamp is database time (bracketed by database
  time, and different from the synthetic tick time); it does not exercise two rows. All six Round/Trip writes (`issueRound`,
  `completeRound`, `spendHint`, `openTrip`, `completeTrip`, `abandonTrip`) read `databaseNow(tx)` once after the player lock
  (one extra query each) and use it for every expiry, floor and `issued_at` comparison. A write's `trip` block is judged at that
  instant; its `progress` block is stamped by `withLiveStreak` after COMMIT, a few ms later, so if `expires_at` falls between the two
  the same response can show the segment live in `trip` and `perfectStreak` 0 in `progress` (display-only; order by
  `(version, evaluatedAt)` still holds; found by the independent review 2026-11-02, left as is). Not covered: the process `now` still stamps `PlayerBalance` row timestamps (`updatedAt`, ledger, outbox). Tests: a process
  clock an hour behind cannot extend an expired segment (`issueRound` gives `trip_expired`), and `completeRound`/`spendHint`
  with a process clock 10 s ahead (too_fast still applies) or behind (banks). Residual race (display-only, the server scores from
  the stored streak): the window runs from `databaseNow(tx)` to COMMIT in an issue; if the old expiry falls inside it, a read
  in that window sees 0 and a later one non-zero at one version. Also a read's snapshot precedes its `clock_timestamp()`, so a
  stale read can be stamped later than a fresher read and 0 could win at one version until the next read or banked Round. Closure
  available, not taken: a margin `version` bump on issues in the last seconds. No migration. Verification (PowerShell, cwd `H:\Work\TheAviationArcade\Backend`): typecheck clean;
  `npm test` 21 files, 502/502; `npm run db:migrate` up to date; `npm run test:e2e` 10 files, 369/369; `npm run build` clean;
  `npm run contracts:write` no diff; `npm run db:generate` "No schema changes". Independent review 2026-11-02: no blocking
  defect; removed an unused local in `GET /v1/me/progress` and corrected the wording above. Unproven: no test runs two rows through
  one mirror tick.

- 2026-10-29 (API/interface review fixes, API 0.6.0): completed-Flight replays now pass the returned player through
  withLiveStreak, so an expired Trip reports zero in both progress and trip. Progress and new UGS snapshots add
  evaluatedAt: version orders stored changes; evaluation time orders time-derived views at equal versions. Reads
  stay read-only (the optional-field and legacy-copy wording of this entry is superseded: 0.7.0 makes evaluatedAt required
  and database-clocked, see Decisions 2026-11-02). Trip opening compares all mutable request fields with the stored
  intent (module, localDate, utcOffsetMinutes, contentVersion; flightCount is fixed at ten); changed-body reuse is
  422 idempotency_key_reused before date freshness, and identical retries still work across midnight. New
  test/api-interface-review.e2e.test.ts: 8 cases, including each changed field, concurrent conflicting payloads,
  expired result replay, cross-API/UGS evaluation ordering and First Class expiry. Six initial regression cases
  failed before the fixes. Mutation: removing the contentVersion comparison failed its regression (200 vs 422);
  the implementation was restored byte for byte. Verification from this folder: npm test 21 files, 502/502;
  npm run test:e2e 10 files, 367/367; npm run typecheck and npm run build clean; git diff --check clean. The first
  full e2e pass exposed an old strict UGS field-list assertion; updated it to assert the worker's exact evaluatedAt,
  then reran the full suite green. No migration or cloud call. Consumers retain the original Trip-open body with its key;
  README, OpenAPI and architecture/design notes document the contract. Test counts above are eccc0c7's own (Codex), not
  re-run by the 2026-11-02 session until its entry below.

- 2026-10-29 (T3 complete, implementer's run, before review): from PowerShell in `H:\Work\TheAviationArcade\Backend` (uppercase H),
  Postgres on 5433 up. `npm run db:generate` produced `0010_trip_completion` with only T3's DDL (renamed with `--name`; a second run:
  "No schema changes"); `npm run typecheck` clean; `npm test` 20 files, 443/443; `npm run db:migrate` applied 0010 to the dev database;
  `npm run test:e2e` 9 files, 358/358 (after review fixes: A21-A24 named tests, live-streak replay, linked complete-then-open, fuller re-derivation); `npm run build` clean. Existing tests changed: `trips.e2e` (the three interim `trip_full` tests now
  assert complete-then-open, the full-segment refusals and a late `complete`; the "completed segment is 410" test completes for real),
  `api.test.ts` (unauthenticated route count 17 -> 18; its by-hand closing of a full segment stays, with a new comment),
  `balance-guard` (new rule, allowlist and tests), `schema-parity.ts` (two new CHECK lists), `openapi.e2e` (a complete flow validated
  against the spec). Re-derivation: stored counters, Cards and earned awards equal the rebuild from stored Rounds and segments. No
  cloud call. Local only.

- 2026-10-29 (B4 dealer.v1.json, implementer's run, before review): new `src/rules/dealer-fixture.ts` (frozen pools, case list, `renderDealerJson()`), `test/dealer-cases.ts` (re-export), `contracts/dealer.v1.json` (generated), `scripts/write-contracts.mjs` writes both files, `test/contracts.test.ts` stale check for both (message names `npm run contracts:write`), `contracts/README.md`, 5 tests in `test/dealer.test.ts`. Pools: `military-v1` = the 30 rows of Unity `Resources/ClientContent/military_questions.json` in file order (photoKey = the row's `photoId`, which `PickMilitaryQuestions` dedupes on; level enum names mapped through `RANK_CATALOG`; a test compares it to that file when present on this machine), `identifier-v1` = the 31 commercial rows of `identifier_questions.json` (29 distinct photos), synthetic `thin-trainee`, `duplicate-answers`, `duplicate-photos`, `too-small`. Cases (89): military-v1 every rank x 3 seeds x both policies (30) + empty and non-ASCII seeds at trainee x both policies (4), identifier-v1 lower-ranks every rank x 3 seeds (15), each synthetic pool x both policies x every rank, seed trip-1 (40). Asserted: no blank photoKey, every string passes `dealAnswerKeyIsPortable`, every case replays through `dealTripWithPolicy`. Expected decks come from the dealer, not by hand. Cross-check (scratchpad only, not in the repo): all 89 cases through a verbatim C# copy of Unity's `BuildDeck`/`BuildMilitaryDeck`/`Fnv1a`/`DeckRandom`/`NormalizeAnswer` on .NET 10 and on Unity 6000.5.8f1 Mono: 0 mismatches on each. Verification (PowerShell, cwd `H:\Work\TheAviationArcade\Backend`): `npm run typecheck` clean; `npm test` 21 files / 502 tests; `npm run test:e2e` 9 files / 359 tests; `npm run build` clean; `npm run contracts:write` leaves `catalog.v1.json` unchanged; `npm run db:generate` no schema changes. Local only; Unity's own EditMode run (XU2) not done.

- 2026-10-29 (B3 Trip dealer, implementer's run, before review): new `src/rules/dealer.ts` and `test/dealer.test.ts` (41 tests, added to
  `vitest.config.ts`). Ported by method name from Unity `InProcessMockBackend.cs` (PickQuestions, BuildDeck, Fnv1a, DeckRandom),
  `.Military.cs` (PickMilitaryQuestions, BuildMilitaryDeck) and `MilitaryContent.NormalizeAnswer`. Interpretations: (1) `dealAnswerKey` works per
  UTF-16 unit like C# `char`: astral letters/digits are dropped, `toLowerCase` per unit (no final sigma), U+0130 left unchanged because .NET
  invariant casing keeps it (dotnet/runtime `pal_casing.c`), NFC and NFD differ; Unicode-table versions of Node and .NET/Unity may differ for new
  characters (B4 fixture and Unity's parity test are the check). (2) `dealTrip` deals blank photo keys like Unity; callers use `dealablePool` (as Unity's importer drops them), and `tripCoverage` does. (3) Unsupported Module: `DealNotSupportedError` (ASSUMPTION). (4) `tripCoverage` deals with a fixed seed; the count varies by seed only
  when photo keys collide. (5) The dealer does not sort the pool: callers pass natural id order (`compareIds` lives in `content/`, not `rules/`).
  Named ASSUMPTION tests: higher ranks nearest first with ties to the lower rank, no own-rank cap of 6 for Military, photo-less rows not dealt,
  commercial rule dedupes photos only. Goldens (4 decks) were produced by a separate Python port of the Unity code and match. Equal Card key
  implies equal deal key is asserted on the client's 31 Military rows (skipped when `../docs` is absent). Verification (PowerShell, cwd
  `H:\Work\TheAviationArcade\Backend`): `npm run typecheck` clean; `npm test` 21 files / 486 tests; `npm run test:e2e` 9 files / 359 tests;
  `npm run build` clean; `npm run db:generate` no schema changes. Local only; Unity not run (U2 is the cross-repo authority).

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
