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
src/rules/                pure, Unity-mirrored logic (+ products.ts catalog later)
src/platform/             client-version gate, rate limit, shutdown/drain, server timeouts
src/players/, src/rounds/ feature modules: controller (HTTP) + service (transactions, domain outcomes)
src/storage/              BlobStore (Bunny / memory / none), key validation
src/content/              staff xlsx import/export: module mappings, pure import planner, service, controller
src/admin/                GET /v1/admin/me (staff check for the website)
```

Concurrency rule: every balance change runs in `DatabaseService.withTransaction` (explicit client,
destroyed on failure), first locks the player row (`SELECT … FOR UPDATE`), and bumps `players.version`.
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
  Awards (Unity owns that catalog), website integration.

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

## Unity Gaming Services (decided 2026-10-27, user)

This backend's Postgres is the **single source of truth** for Miles, Status Points, ranks, Rounds and
entitlements. UGS never holds a copy of player progress: no Cloud Save mirror, no UGS Economy currency.
UGS is used only where it adds something we don't build (e.g. Analytics).

State found on 2026-10-27 in Unity v2: `authentication`, `cloudsave`, `cloudcode`, `analytics` packages are
installed, but Authentication is never called (backlog BLK-10). The only Cloud Save/Cloud Code code is
Unity's Blocks Achievements sample; the game's Field Awards are separate (`_Project`). Nothing to sync.

If a UGS service that needs a player is adopted later:

- **Identity:** UGS Authentication with Firebase as an OpenID Connect custom ID provider (issuer
  `https://securetoken.google.com/<projectId>`); the game calls `SignInWithOpenIdConnectAsync` with the
  Firebase ID token. The UGS player then derives from a verified Firebase token. Never accept a
  client-supplied UGS player ID as a link to our principal.
- **UGS → backend:** Triggers webhook action, authenticated with `{{ hmac_sha256 "SECRET" }}` over the
  rendered body (or the `{{ jwt }}` header, checking project/environment claims). Idempotent on
  `X-Unity-Event-ID`; return non-2xx only on transient failure (5xx/timeout/429 are retried, then
  dead-lettered; other 4xx are dropped). Public URL only, so local testing needs a tunnel.
- **Backend → UGS:** Admin REST with a service account, via `POST
  https://services.api.unity.com/auth/v1/token-exchange` (1 h JWT; 20 req/s). Credentials come from the
  host environment, never the repo.

Docs: docs.unity.com — `triggers/webhooks`, `authentication/openid-connect`,
`services-web-apis/service-account-auth`. Re-check before building; these were read on 2026-10-27.

## Sign in with Apple (if the project rule changes)

Unity native SIWA with nonce → Firebase `apple.com` credential → normal Firebase ID token. Backend
change: add `apple.com` to the allowed providers + tests. Never merge accounts by email server-side.
Account deletion must revoke the Apple token.
