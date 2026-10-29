# Architecture baseline

Decided 2026-10-27. Rule: build well-defined basics that earn their place; nothing speculative.

## Platform

A standalone **Node** server, deployed separately from the website (which stays on Cloudflare):
**NestJS** (default Express platform), **PostgreSQL** via **Drizzle ORM** + `pg` (same ORM family as the
website), **zod 4** validation, **jose** for Firebase ID tokens. Local Postgres runs in **Docker Compose**.
Hosting target is not chosen yet.

Replaced on 2026-10-27: the first slice was a Cloudflare Worker (Hono + D1). Behaviour, API, rules and
tests were ported unchanged; D1's optimistic batch/retry became Postgres transactions with row locks.

## What we take from the company nodeDemo, and how

`mayurkmphasis/nodeDemo` (Express + Mongoose) was reviewed as a **checklist of concerns**, not as code:
its implementations have critical security defects (unauthenticated token minting and password reset,
unverified social login and subscription grants, committed and publicly served keys).

| Concern | nodeDemo | Our version | When |
|---|---|---|---|
| One error type + stable codes | `appError`, `messages.js` prose catalog | `ApiError(status, code, message)`; typed `ErrorCode` union Unity switches on; real HTTP statuses; `{error:{code,message,requestId}}` via one global exception filter | Node re-platform |
| Validation at the edge | joi (validated result discarded) | zod 4 strict schemas through a `ZodValidationPipe`; no class-validator | Node re-platform |
| Route modules | Express sub-routers | NestJS feature modules (controller + service per aggregate) | Node re-platform |
| Request logging | winston to public files, full bodies | One JSON line per request (id, route, status, ms) to stdout; `X-Request-Id`; never bodies/tokens | Node re-platform |
| Client version gate | string compare against DB | `X-Client-Version` integer vs `MIN_CLIENT_BUILD` config → 426 `client_update_required` | Unity integration slice |
| Rate limiting | express-rate-limit (disabled) | `@nestjs/throttler`, keyed by principal (IP for public routes); shared store (Redis or Postgres) once there is more than one instance; 429 `rate_limited` | Rate-limit slice |
| API contract | Postman → generated Swagger served in prod | `docs/openapi.yaml` (or generated from zod via `z.toJSONSchema`) + parity test; not served publicly | Unity integration slice |
| Reference data | seeder on every boot (incl. an admin password) | Drizzle migrations; never credentials | As needed |
| Soft delete | `deletedAt`, keeps PII | Real deletion/anonymisation (store requirement) + Apple token revocation | Account-deletion slice |
| IAP flow shape | submit → verify → server notifications | Re-fetch from App Store Server API / Play Developer API; verified notifications; idempotent tables; see Purchases | Purchases slice |

## What we deliberately do not build

A repository class per table (services own their SQL; add a cross-aggregate service only when one use
case spans two) · a response envelope repeating the status, or non-HTTP codes (433/327) · our own JWT/
password/OTP auth (Firebase owns credentials) · HMAC request signing (the secret ships in the app; use
Firebase App Check later if genuine-app proof is needed) · runtime secret fetch from Infisical (secrets come
from the host's environment/secret manager) · player uploads/multer (the one upload we do accept is a staff-only xlsx on `/v1/admin/content/:module/imports`: route-scoped raw body, 5 MB, nothing else changes) · socket.io · nodemailer/Twilio/OTP
(Firebase handles email flows) · Stripe/PayPal (the product sells nothing on the web; digital goods go
through the stores) · mongodump-style restore scripts (use the managed Postgres provider's backups / PITR)
· `google-play-billing-validator` (stale; use the Play Developer API v3 directly).

## Layout

```
src/main.ts               bootstrap: request id + log middleware, global filter, shutdown hooks
src/config/               env parsed once with zod; fail fast
src/db/                   drizzle schema + pg Pool provider; migrations in drizzle/
src/common/               ApiError + ErrorCode, exception filter, ZodValidationPipe, request-id middleware
src/auth/                 firebase.ts (framework-free verifier), FirebaseAuthGuard, @Principal()
src/rules/                pure, Unity-mirrored logic: scoring, ranks (isPleasureCruise), first-class, banking (bankRound), trips, Clipper Cards, Field Awards (+ products.ts catalog later)
src/platform/             client-version gate, rate limit, shutdown/drain, server timeouts
src/players/, src/rounds/, src/trips/ feature modules: controller (HTTP) + service (transactions, domain outcomes); src/trips/trip-store.ts holds the segment helpers RoundsService shares, src/trips/trip-completion.ts completes a full segment (Cards, counters, awards)
src/storage/              BlobStore (Bunny / memory / none), key validation
src/content/              staff xlsx import/export: module mappings, pure import planner, service, controller
src/admin/                GET /v1/admin/me (staff check for the website)
src/ugs/                  UGS progress mirror: link route, token check, outbox helper, worker, admin client
```

Concurrency rule: every balance change runs in `DatabaseService.withTransaction` (explicit client,
destroyed on an unexpected failure; a deliberate rollback such as a refused spend keeps it), first locks the player row (`SELECT … FOR UPDATE`), and bumps `players.version`.
Round, hint and shop writes (and the Active Rank change) all go through `PlayerBalance.update` in `src/balance/`,
which owns the lock, the ledger postings, the relative balance update, the version bump and the mirror enqueue (its
invariants are written on the class); callers keep their own SQL for their own tables inside the same transaction.
`bankRound` (`src/rules/banking.ts`) is the pure composition RoundsService calls inside that transaction: award (scoreRound + First Class Pass +
Pleasure Cruise), paid-or-claimed hint, new Perfect Streak and promotion in one result. No DB types. The Perfect Streak is
per Flight Segment (D-3, built in T2): `bankRound` is unchanged, the caller passes `players.perfect_streak` as
`state.perfectStreak`, and that stored value means "the open segment's streak" because every open, abandon and expiry resets
it (only when it is not already 0, so a no-op never bumps the version).

Flight Segments (Unity Trips, `trips`): one open per player (unique partial index), snapshotting module, Active Rank and
Pleasure Cruise at open. Lock order is player (`PlayerBalance.update`) → trip → Round → `player_counters`. Expiry is lazy: a
segment 30 minutes past its last activity with fewer than ten banked Rounds is expired for every route that touches it and is
closed (at its expiry) by the next write that sees it; there is no sweeper. `trips`, `player_counters` and the day log are written
only inside `PlayerBalance.update`'s transaction, by the files listed in `TRIP_WRITERS` in `test/balance-guard.test.ts` (a
structural guard). A Round result also writes the day log (`player_counters`) and may post a `day_streak_grant` hint, in the same
transaction as the Miles posting.

Completing a segment (T3, `POST /v1/trips/{id}/complete`, or implicitly when `POST /v1/trips` finds a full open one) runs
in one `PlayerBalance.update` transaction, in the lock order player → trip → Round → `player_counters` / Cards / awards:
the ten banked Rounds are folded in flight order through the pure `applyCompletedTrip` (counters, Go Around, Red-Eye), each
finished Round with a Card key upserts `player_clipper_cards`, all 28 awards are evaluated against `catalogInForce()` (a code
constant until T4 reads `content_documents`) and the new ones are inserted into `player_field_awards`, the segment row gets its
result columns, and the Trip hint is the only posting (`trip_grant`, UNIQUE (player, kind, ref = tripId)). The step is
`republish` + `mirrorNow`; `players.version` bumps only when a hint is granted or the streak was not already 0 (U2). The answer
is read back from the tables (Cards by `first_trip_id`, awards by `trip_id`, the hint from the ledger), so the first answer and
every replay are the same lists. `player_clipper_cards` and `player_field_awards` are written only by
`src/trips/trip-completion.ts` (`AWARD_WRITERS` in the balance guard). `player_counters` is a cache: `test/trips.e2e.test.ts`
rebuilds it from stored segments and Rounds (`deriveDayLog`, `deriveTripCounters`) and compares.

`PlayerBalance` is a deep module with one Postgres adapter, not a seam. Player creation (`open`: INSERT ... ON CONFLICT
DO NOTHING, the one write that cannot lock first), deletion (`erase`) and the UGS link records (`linkUgs`) live in it too.
`enqueueMirror` and the `ugs_mirror_deletions` writes sit in `src/balance/mirror-outbox.ts`, private to the module:
`test/balance-guard.test.ts` fails if any file outside `src/balance/` locks `players` FOR UPDATE, calls those helpers,
or inserts into the mirror queue tables or the ledgers (the checker is multiline-aware and unit-tested on seeded violations).
No write overwrites another. The database also enforces one open Round per player (unique partial index).

Auth is global (`APP_GUARD`); a route is public only with `@Public()` (health). Production config refuses
emulator tokens and demo projects, and never reads `.env`.

## File storage: Bunny (decided 2026-10-27, user)

Any file or blob the backend stores (content-release packages and images, exports) goes to **Bunny
Storage** through its S3-compatible API, the same provider as the website (`../website/docs/BUNNY_STORAGE_SETUP.md`).
Not R2, S3 or local disk, and never as blobs in Postgres; Postgres keeps only keys/metadata.

- Website zone: `aviation-arcade-website`, Frankfurt `de`, endpoint `https://de-s3.storage.bunnycdn.com`,
  S3 compatibility on (it can only be enabled when a zone is created). **Decided 2026-10-28 (user): the backend
  shares that zone** under the key prefix `backend/` (`BUNNY_STORAGE_PREFIX`), so it never touches the website's
  objects. The first files stored are staff xlsx imports at `backend/imports/<module>/<sha256>.xlsx`. Built and
  tested against an in-memory fake and a stubbed signer; the real zone is probed only with the user's sign-off
  (`npm run bunny:check`).
- Private by default: no public pull zone for originals; serve through authenticated routes or
  short-lived signed URLs. A public CDN pull zone only for content that is meant to be public.
- The read-write Storage Zone Password (S3 secret) comes from the host environment, never the repo or
  logs; not the Bunny account API key. No zone creation or other Bunny account change without user sign-off.
- Verify with a probe like the website's `npm run bunny:check` (upload one random object, compare bytes, delete).

## Admin content store (Phase 5.0, decided 2026-10-28, user)

- **Authority.** Backend Postgres is the source of truth for admin-curated content (`content_items`, one row per
  module + id; payload in `data` jsonb, validated by the module mapping before every write). The website admin
  and Unity consume it in follow-ups; there is no player-facing content route and no release yet, so nothing
  reaches players.
- **Staff.** Token `email_verified === true` AND the lowercased `email` in the server-only `STAFF_EMAILS`
  allowlist (the website's rule). `@StaffOnly()` + `StaffGuard` run after the auth and rate-limit guards (401
  first, then 403 `forbidden`). A client-chosen role, header or query never grants anything. A staff caller needs
  no player row. No email is stored anywhere: rows carry the principal only.
- **Import (`POST /v1/admin/content/:module/imports`).** Raw xlsx, 5 MB. Unzip-bomb guard before parsing
  (`fflate` streaming count of real output: 25 MB / 100 entries; the xlsx libraries have none), plus 5,000 rows
  and 50 columns checked on the cell references in every worksheet's XML before `read-excel-file` runs (it
  allocates a dense grid up to the furthest cell, so one cell at `XFD1048576` in a 3 KB file would exhaust memory).
  The upload middleware verifies the token and the staff rule before reading the body. The pure planner (`planImport`) treats two kinds of file differently (user, 2026-10-28):
  - *Client sheet* (no `Id` column) is authoritative. Rows match stored items by natural key (Military: the
    trimmed `file`, exact). Unmatched rows get the next free id (`mil-a<max suffix + 1>`, sheet order; into an empty
    module that is row order, so `mil-a1`…). A matched row with different rank/data is an update (version + 1,
    source `client_sheet`, `updated_by`) and the dry run returns a field-level diff `{ field, from, to }`. Stored
    approved items the file omits are retired (status `retired`, version + 1); a retired item listed again returns
    to `approved` (version + 1). A blank or repeated natural key is a row error, into an empty module too (user, 2026-10-28), so later
    sheets can always match by it; we never guess. Re-importing the original sheet is all `unchanged`.
  - *Admin export* (has `Id`) keeps the Version check: no `Version` → create / unchanged / conflict; with
    `Version` → update / unchanged / conflict (source `admin`). It never retires, and its `Status` column is
    ignored on import. The resulting module (retired items included) must keep natural keys non-blank and
    unique, and new ids may not exceed the highest existing number plus the file's row count.
  - Gaps (empty `Photographer`/`file`) import as `approved` with warnings. Duplicate ids and unknown levels are errors.
  - *Confirm before overwrite.* The dry run returns `planHash` (sha256 of the canonical plan: actions, ids, content,
    diffs, retirements, against the stored versions). A client-sheet apply that would update or retire anything
    needs `?confirm=<planHash>`: missing → 422 `import_invalid` ("dry run first"); mismatch with the re-plan made
    under the lock (data changed since the dry run) → 409 `plan_changed`, nothing written. Creates-only applies and
    admin-export applies need none.
  - Any error or conflict → 422 `import_invalid` + report; nothing written. Apply: replay check first — identical
    bytes replay only while their receipt is the module's latest import (a dry run reports `replay: true`), so a
    retry is safe but re-applying an older file is planned normally; then store the original (content-addressed,
    so an orphan after a failed commit is harmless; **originals are kept forever**), then one transaction under
    `pg_try_advisory_xact_lock` per module (busy → 409 `import_in_progress`, never a pooled connection parked on the
    lock) that repeats the replay check, re-plans against the locked rows, checks the confirm hash against that
    re-plan, and writes receipt, items, retirements and an append-only `admin_audit` row (with the updated and
    retired ids). Re-applying older bytes refreshes their existing receipt (UNIQUE module + sha256). Storage down or
    refusing → 503 `storage_unavailable` (Retry-After only when transient).
  - Military is the only importer for now; other modules need their own mapping.
- **Export.** `.xlsx` with `Id, Version, Level, Correct Answer, Wrong Answer 1-3, file, Photographer, Status`, retired
  rows included (`Status` is informational and ignored on import); editing it and re-importing is the edit path (no
  in-place edit endpoints yet).
- **Callers.** The website reaches this API server-to-server through its Worker; browsers never call it, so there is
  no CORS configuration (none is added).
- **Not built (follow-ups).** Releases and versioned packages, player content delivery, server answer checks,
  photo upload and serving, edit-in-place endpoints, importers for the other seven modules, Field
  Awards (the backend owns the catalog, thresholds and progress since C12, 2026-10-28; built after the Trips contract),
  website integration.

## Purchases (design for the purchases slice)

- Client sends only a store reference (Apple `transactionId`, Google `purchaseToken` + `productId`).
  Server re-fetches from the store, checks bundle/package, catalog product, ownership token
  (`appAccountToken` / `obfuscatedAccountId` = random per-player UUID, never the uid) and revocation.
- Apple: on Node, Apple's official `@apple/app-store-server-library` is usable (API client + signed-data
  verification against Apple roots). Google: Play Developer API v3 (`subscriptionsv2.get`,
  `products.get`, acknowledge/consume) with a service-account token.
- Tables: `store_transactions` (unique per store transaction; idempotent credits), `store_subscriptions`
  (owner set once, status incl. grace/billing-retry/revoked, `last_event_at` ordering guard),
  `store_notifications` (dedupe). Later `miles_ledger` with unique refs.
- `players.first_class_until` is only ever **recomputed** from active/grace subscriptions inside the
  player-locked transaction — the single write path. Consumable credits follow the `completeRound` pattern.
- Notifications: Apple ASSN v2 (signed, re-fetch status, handle renew/grace/expire/refund/revoke) and
  Google RTDN (Pub/Sub OIDC verified with jose, re-fetch `subscriptionsv2`, voided purchases). Return
  non-2xx on transient failure so stores retry. Acknowledge/consume Google purchases after commit.
- 409 purchase owned by another player, 422 invalid/revoked, 503 `store_unavailable` (never grant
  optimistically), 200 + `replayed` on repeat.
- **Decided 2026-10-27 (user):** sandbox (TestFlight / App Review) purchases grant real entitlements and
  rewards in production. Still record `environment` on every row for auditing.
- **Decided 2026-10-27 (user):** a refunded Status Point boost is reversed only if it has **not been used**;
  once used it stays. Implies a boost is held as an unused item and applied when the player uses it, so
  "Certified Rank never drops" holds. (Interpretation of "used" to confirm when the boost slice starts.)

## Unity Gaming Services (revised 2026-10-28, user)

**Decision (2026-10-28, binding; reverses the 2026-10-27 "UGS keeps no copy" ruling).** UGS is the first support path for
the game: it reads progress (and, later, content) from UGS first; this backend is the authority and the backup. Postgres
remains the **only writer** of Miles, Status Points, ranks, Rounds and entitlements and the server computes every award.
UGS receives a **one-way, server-written, player-read-only mirror** of progress in Cloud Save. The game never writes
progress to UGS and the backend never reads progress back from UGS. No UGS Economy currency. Content via CCD/Remote Config
with a Bunny backup is a follow-up, with releases.

State found on 2026-10-27 in Unity v2: `authentication`, `cloudsave`, `cloudcode`, `analytics` packages are installed,
but Authentication is never called (backlog BLK-10); the only Cloud Save/Cloud Code code is the Blocks Achievements
sample. Nothing existed to sync.

**Verified facts (2026-10-28, from docs.unity.com; re-check before changing):**

- Cloud Save player data **Protected** class: the player reads their own, only the server writes. Admin write: `POST
  https://services.api.unity.com/cloud-save/v1/data/projects/{projectId}/environments/{environmentId}/players/{playerId}/protected/items`
  with `{ key, value, writeLock? }`, returns `{ writeLock }`; value JSON up to 5 MB. Auth: `Authorization: Basic
  base64(keyId:secret)` of a service account with the role Cloud Save Editor (documented for the Cloud Save admin API, so
  no token exchange). Delete: `DELETE .../protected/items/{key}`.
- **Admin API rate limit: 60 req/s and 1,000 requests per 30 minutes per project per IP (about 33/min sustained).** This is the
  binding constraint and why the mirror is paced (default 25/min) and coalesced per player.
- UGS player tokens: RS256, JWKS `https://player-auth.services.api.unity.com/.well-known/jwks.json` (kid `public:<uuid>`), `iss`
  `https://player-auth.services.api.unity.com`, `sub` = the UGS player id, `exp`/`nbf`.
- Player Auth admin: `GET https://services.api.unity.com/player-identity/v1/projects/{projectId}/users/{playerId}` (Basic
  service account; the API must be enabled in the dashboard) returns `externalIds[] { externalId, providerId }`. Rate limit
  10 req/s and 500 per 30 minutes.

**UNVERIFIED (kept as `ASSUMPTION` tests; confirm against a real UGS project before relying on them).:**

1. The token claims `project_id` / `upid`, `envId` and `idd` are described only in a support article. The code requires a
   project claim (either name), checks `envId` when present, and ignores `idd`.
2. That the `externalId` of the OIDC link equals the Firebase uid, and that `providerId` equals the provider id configured
   in `UGS_OIDC_PROVIDER` (for example `oidc-firebase`). If the service account credential is rejected, link answers 503
   `service_unavailable`.

**Identity link (`PUT /v1/me/ugs-link`).** UGS Authentication with Firebase as an OpenID Connect provider (issuer
`https://securetoken.google.com/<projectId>`); the game signs in with the Firebase ID token and sends the resulting UGS token.
The server verifies it (jose, remote JWKS with the same fail-closed key handling as Firebase: unreachable keys are 503
`auth_unavailable`; a bad UGS token is 400 `invalid_request`, because 401 is reserved for the Firebase token), then proves
the link server-side with Player Auth admin (403 without proof; UGS down is 503 `service_unavailable`). A client-supplied UGS
player id is never accepted. Table `ugs_links` (`player_id` PK, `ugs_player_id` unique): re-link to the same UGS player is an
idempotent 200 that changes nothing; to another replaces the link under the player lock, bumps `version` once (D-1) and
queues deletion of the old copy (a first link enqueues at the current version without bumping it); a UGS player already
linked to another principal is 409 `ugs_link_conflict`, unless the same proof shows UGS no longer lists that principal's
uid, in which case the link moves (both players locked in id order; the caller's `version` is bumped, the old holder's
is not). A token for the UGS
player already on record is answered from `ugs_links` without a Player Auth call. Proof calls are limited to 5 per hour per
principal (in memory, per instance) and by the shared `player_auth_admin` budget row (12/min, burst 10, across all instances) under the
500 per 30 min Player Auth admin limit.

**Outbox and worker.** `ugs_mirror_outbox` holds at most one row per linked player (`version` = highest seen, `generation` =
count of enqueues, `due_at`, `attempts`, short `last_error`). `PlayerBalance.update` calls the helper
(`enqueueMirror`, private to `src/balance/`) inside the same transaction, after the player row is locked and updated, for every write that changes
what the mirror shows: Round result, hint spend, hint pack, Active Rank change, UGS link records (`PUT /v1/me` creation calls it
too, a no-op because a new player has no link). Every such change bumps `players.version` (D-1, 2026-10-29), so
`version` is the total order of copies and `GET /v1/me/progress` returns it; the row also carries a `generation` drawn from a sequence (never repeats, even
after the row is deleted and re-inserted) and each claim stamps a `claim_id`; the worker deletes or releases a row only if
both still match its claim, otherwise it is due again at once (migration 0007). The in-process worker (`src/ugs/`, only when
configured) is policy only (pacing, pauses, backoff, logging) and drives two `MirrorQueue` adapters in `src/ugs/mirror-queue.ts`, deletions first:
`ProgressWriteQueue` (`ugs_mirror_outbox`, with the generation-checked completion) and `CopyDeletionQueue` (`ugs_mirror_deletions`, with the
re-link check); tests use an in-memory queue (`test/in-memory-mirror-queue.ts`) for the claim/process/release contract. Each queue
claims due rows in a single `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` that moves `due_at` to a lease
of batch size × request timeout + 60 s (260 s), so instances never share a row and no network call is made while a row or
player lock is held. It reads the current player,
writes the Protected key `progress` (no `writeLock`: Postgres is the only writer and `version`/`updatedAt` in the value order
updates), paced by the shared Cloud Save budget (`UGS_MIRROR_MAX_PER_MIN`, burst ≤ 10, one Postgres row for all instances;
see "Budget and interval" below). A 429 pauses ALL instances for `Retry-After`; 401/403 (our credentials) pause all of them for
15 min with one error log; 5xx or network errors back off per row (5 s doubling, cap 15 min); another 4xx is logged once and a
write is dropped after 3 rejections (the next change re-queues it), a deletion retries daily. Each tick with due rows logs
backlog and lag. On shutdown it stops before the pool closes and aborts in-flight requests. Account deletion and re-link
record the old UGS player id in `ugs_mirror_deletions` in the same transaction, due at lease + request timeout so a write
already in flight cannot land after it; the worker deletes the Cloud Save item (retried). Known gap: a write in flight for a
holder at the moment its link moves can still land on that UGS player; the new holder's next write overwrites it.

**Budget and interval (D-4, C3; migration 0008).** Cloud Save writes and deletions share one token bucket across ALL instances:
the row `cloud_save_admin` of `ugs_budget` (`tokens` as of `refilled_at`, `paused_until`; rate `UGS_MIRROR_MAX_PER_MIN`, burst
min(rate, 10), both from configuration, so every instance must run the same value). `PostgresUgsBudget.reserve` runs in one short
transaction (`SELECT ... FOR UPDATE` on the row, the pure refill step shared with the in-memory bucket, `UPDATE`; no network call
while it is held). A tick with due rows reserves min(due rows, 20) tokens BEFORE claiming (an idle tick reserves nothing and does not touch the row),
claims at most that many rows (deletions first), and refunds every token it did not spend (unclaimed rows, rows released after a pause). A 429 or refused credentials write `paused_until`
(never shortened), which stops every instance at its next reserve. **A pause lives in the row, so it survives a restart of every
instance; to resume early after fixing credentials run `UPDATE ugs_budget SET paused_until = NULL WHERE name = 'cloud_save_admin'`
(the next tick reserves again).** Clocks: `PostgresUgsBudget` does all refill and pause arithmetic on the DATABASE clock
(`clock_timestamp()`; `pause` keeps only the duration the worker computed), so one instance's wrong clock can neither freeze nor
inflate the budget; the `nowMs` argument matters only to the in-memory twin and to tests (`budgetTime: "caller"`). Defence in
depth: a stored `refilled_at` more than 5 minutes ahead of now is clamped to now, and a clock that moves backwards mints nothing. The in-memory twin (`InMemoryUgsBudget`) is for unit tests. Guarantee: the sum of grants over all
instances is at most burst + rate x elapsed. Link proofs have their own row, `player_auth_admin` (12/min, burst 10); the 5 proofs
per hour per principal stays in memory, per instance (a fairness limit, not the UGS budget). If the table is unreachable the tick
fails and is logged; nothing is written to UGS without a reservation.

C3: a copy write for one player waits at least `UGS_MIRROR_MIN_INTERVAL_SEC` (default 300, 0 disables) after the previous one.
The worker records `ugs_mirror_pace(player_id, ugs_player_id, last_mirrored_at)` after each successful write (a table of its own,
because `ugs_links` is written only by `PlayerBalance`). `enqueueMirror` inserts a new row with `due_at = GREATEST(now,
last_mirrored_at + interval)` where the pace row must name the CURRENT link. A row that already exists keeps its `due_at` if it is
claimed or backing off; a waiting row takes `LEAST(its due_at, the new one)`: the same time for a Round on the same link (it
coalesces and writes the latest version once), but now after a re-link or link move. A change that lands while the write is in
flight re-queues the row with the same rule from the pace row of the current link (one interval after that write, or now when the
player re-linked meanwhile). An urgent enqueue on a claimed row is kept in `ugs_mirror_outbox.urgent` (a column rather than
moving `due_at`, which is the lease while claimed, so the lease keeps protecting the in-flight write); the reset honours and
clears it, and release/fail clear it too. Exempt:
the first write after a link, a re-link to another UGS player and a link move (the pace row names the UGS player it was
written for, so a different current link means "never written"), and deletions, which never use it. A waiting row is not
"due", so it does not show as backlog or lag. The write at Trip end (built in T3: `complete`, and an open that completes a full segment, set it): `PlayerBalance`
`Step.mirrorNow` (honoured only when the step enqueues: a change, a changed profile or `republish`) / `enqueueMirror({ dueNow })` makes the row due now, pulls a waiting row forward, and is remembered on a claimed row (backing-off rows keep their backoff).

**UGS to backend (unchanged, not built).** Triggers webhook action authenticated with `{{ hmac_sha256 "SECRET" }}` over the
rendered body (or the `{{ jwt }}` header), idempotent on `X-Unity-Event-ID`; public URL only.

Docs: docs.unity.com `cloud-save` (data access classes, admin API), `authentication/openid-connect`, `services-web-apis`,
`triggers/webhooks`.

## Sign in with Apple (if the project rule changes)

Unity native SIWA with nonce → Firebase `apple.com` credential → normal Firebase ID token. Backend
change: add `apple.com` to the allowed providers + tests. Never merge accounts by email server-side.
Account deletion must revoke the Apple token.
