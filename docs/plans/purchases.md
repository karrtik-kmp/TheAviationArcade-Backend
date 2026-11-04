# Purchases (Phase 4), wave P: catalog, purchase route, fake store

Status: **built** (2026-11-04, slices P-A, P-B, P-C; integration by the lead). Earlier: approved with changes, revised (2026-11-04). Reviews: senior-lead, backend-expert, game-domain-expert (all
"approve with changes"); every finding is folded in below. Design: `docs/ARCHITECTURE.md` "Purchases"; port: brief S8
(`../docs/briefs/backend.md`); proposed contract: **`../docs/briefs/commerce.md`** (Unity session, 2026-11-04), adopted.

## User rulings (2026-11-04)

- R1 "Use demo plans for now and start working; the plans can be modified and added." → staff-editable catalog, seeded with
  **the client's catalog** (Unity CF-33 / BLK-13, `Contracts/products.v1.json`): `aa.hints.5` (+5 hints), `aa.hints.15`
  (+15 hints), `aa.firstclass.monthly`, `aa.firstclass.yearly`. These rows are `demo` because the **store ids are
  placeholders** (final ids: Unity Q4); the hint counts and monthly/yearly split are client numbers. No Miles are sold
  (Miles are earned and spent; `aa.hints.miles` is the existing `/v1/shop/miles-hint-pack`, not a store product).
- R2 The First Class **+50% stays ON** in the backend (`src/rules/scoring.ts:63`). A Pass bought here makes it live. Unity
  wires it `false` today (pending CQ1); the user's ruling is sent to Unity to align (rules-sync).
- R3 **Adopt the commerce brief**: `commerceToken` via `GET /v1/me/entitlements`, 409 `purchase_owned_by_other`, response
  `{ status, replayed, storePurchase, progress }`, schema names `StorePurchaseRequest` / `StorePurchaseResponse` /
  `Entitlements`, and **a purchase with no account token is owned by the first verified caller, set once**.
- R4 **Account deletion is final**: store token and purchase rows cascade, but a no-personal-data `store_claims` tombstone remembers every granted store reference, so an old receipt (tokened or not) answers 409 for any new account.
- Deviation from brief S8 step 1 (port lands with only the fake adapter), by R1. Mitigation: the fake cannot be configured
  in production or against a real Firebase project; demo products are never listed or sold in production.

## Non-goals (this wave)

Real Apple / Google adapters (P2, P3); store notifications, acknowledge retry sweeper, refunds/revokes after grant (P4);
ads and Pass hint grants (brief "Ads", U7: later waves, their hint kinds then); Status Point boosts (P5, IAP-2/3); prices.

## Slice P-A: contract, schema, shared catalog read (first)

**Migration `0020_store_purchases` (generated; second `db:generate` reports no changes):**

`store_products`: `product_id` text PK (`^[a-z0-9][a-z0-9._]{0,99}$`), `kind` CHECK IN (`hint_pack`, `first_class_pass`),
`hints` int (hint_pack: 1..1000, else NULL), `pass_period` CHECK IN (`P1M`, `P1Y`) (first_class_pass only, else NULL;
informational, the store's expiry is authoritative), `title` text 1..100 (**staff-only**, never shown to players), `demo`
boolean, `status` CHECK IN (`active`, `retired`), `version` int >= 1, `created_at`, `updated_at`. Per-kind rule CHECK.

`store_accounts`: `player_id` PK → players ON DELETE CASCADE, `commerce_token` uuid UNIQUE, `created_at`.

`store_transactions`: `store` CHECK IN (`apple`, `google`), `transaction_ref` text, UNIQUE (store, transaction_ref);
`player_id` → players ON DELETE CASCADE (index); `product_id` → store_products RESTRICT; `kind` (same list as products);
`environment` CHECK IN (`production`, `sandbox`, `fake`); `order_id` text null; `original_ref` text null;
`purchased_at`; `granted_hints` int null; `granted_until` timestamptz null; `created_at`. Rule CHECKs: hint_pack →
granted_hints NOT NULL and original_ref NULL; first_class_pass → granted_until and original_ref NOT NULL.

`store_subscriptions`: PK (store, original_ref); `player_id` → players ON DELETE CASCADE (index), set once; `product_id`;
`status` CHECK IN (`active`, `grace`, `billing_retry`, `on_hold`, `expired`, `revoked`) (pinned now for P4);
`expires_at`; `last_event_at`; `created_at`, `updated_at`.

`hint_ledger_kind_check` + `store_purchase`; `admin_audit_action_check` + `store_product_create`, `store_product_edit`,
`store_product_retire`, `store_product_restore`.

TS lists in `src/db/enums.ts` (`STORE_PRODUCT_KINDS`, `STORE_PRODUCT_STATUSES`, `STORES`, `STORE_ENVIRONMENTS`,
`STORE_SUBSCRIPTION_STATUSES`, audit actions) and `ledger-kinds.ts`; every new IN-list CHECK in `EXPECTED_ENUM_CHECKS`, rule
CHECKs in `RULE_CHECKS` with a behaviour test (`test/schema-parity.ts`).

**Contract `docs/openapi.yaml` (API 0.20.0), all `x-planned` / `x-planned-enum`** (the parity test forbids built routes and
`ERROR_CODES` before they are served; the lead drops the marks at integration and runs `npm run contracts:write`). Every
purchase outcome documents the client action, **finish** or **keep pending**:

| Answer | Client action |
|---|---|
| 200 `status: granted` (new or `replayed: true`) | finish the store transaction (consume consumables per D3) |
| 200 `status: pending` (valid store purchase, product not in the catalog or not sellable here; nothing written) | keep pending, resend later |
| 503 `store_unavailable` + `Retry-After` (store transient, or no verifier configured; nothing written) | keep pending, resend |
| 409 `purchase_owned_by_other` | finish (it belongs to another account) |
| 422 `purchase_invalid` (store says invalid), `purchase_revoked` | finish; nothing granted |

Routes: `POST /v1/purchases`, `GET /v1/me/entitlements`, `GET /v1/store/products`, `GET /v1/admin/store/products`,
`PUT /v1/admin/store/products/{productId}`, `POST .../{productId}/retire`, `POST .../{productId}/restore`; planned only (P4):
`POST /v1/store/notifications/apple`, `POST /v1/store/notifications/google`. Codes: `store_unavailable`, `purchase_invalid`,
`purchase_revoked`, `purchase_owned_by_other`.

**Shared code (P-A owns; P-B and P-C import, never edit):** `src/store/catalog.ts` (`findProduct(tx|db, id)`,
`isSellable(product, appEnv)` = active-or-retired and not (demo and production); `isListed` = active and not (demo and
production)), `src/store/demo-products.ts` (the one seed list, from R1), `test/store-helpers.ts` (seed the demo list,
grant/revoke admin role helpers reuse `test/roles-helpers.ts`). Skeleton `src/store/store.module.ts`,
`src/purchases/purchases.module.ts` in `app.module.ts`. Config `STORE_VERIFIER = none | fake` (default none); `fake` is a
config error unless `APP_ENV != production` AND (`APP_ENV = test` OR `FIREBASE_PROJECT_ID` starts with `demo-`) (same shape
as the emulator-token rule). `.env.example`.

## Slice P-B: catalog (after P-A, parallel with P-C)

- `GET /v1/store/products` (signed-in): listed products `{ products: [{ productId, kind, hints?, passPeriod? }] }`. No
  title, no price (the app shows its own client-supplied copy and the store's localized price).
- Admin (`@Roles("admin")`, same guards as `ContentAdminController`; 403 test for a player): `GET` all with `version`,
  `title`, `demo`, `status`; `PUT` strict `{ version?, kind, title, hints?, passPeriod?, demo }`: no `version` = create
  (409 `version_conflict` if it exists), with `version` = edit; `kind` and `demo` immutable (422 `content_invalid`);
  creating `demo: true` in production is 422. `retire` / `restore` with `{ version }`. One audit row per write (principal
  from the token). Edits never change past grants (grants are snapshotted).
- `npm run store:seed-demo` (refused in production; idempotent: creates missing rows from `demo-products.ts`, never edits).
- Production start: log a warning if any active demo product exists (they are hidden and unsellable anyway).

## Slice P-C: purchases (after P-A, parallel with P-B)

**Port** `src/purchases/store-verifier.ts` (brief S8): `verify(ref, signal) → valid{tx} | invalid{reason} |
transient{retryAfterMs?}`; `acknowledge(tx, signal) → ok | transient` (Google only). `VerifiedTransaction = { store,
environment, productId, transactionRef, originalRef | null, orderId | null, accountToken | null, purchasedAt,
expiresAt | null, revoked }`. Field mapping, pinned now: Apple `transactionRef` = `transactionId`, `originalRef` =
`originalTransactionId`. Google (re-check against the Play docs in P3 before any real row): one-time `transactionRef` =
`purchaseToken`; subscription `transactionRef` = per-renewal `orderId`, `originalRef` = first `purchaseToken` of the
`linkedPurchaseToken` chain. Account tokens compare after lower-casing and stripping hyphens (Google gets 32 hex, D4).

**FakeStoreVerifier**, deterministic, no clock: reference `fake~<outcome>~<productId>~<token|none>~<purchasedAtSec>[~<expiresAtSec>]`,
split on `~` (product ids contain dots), outcome ∈ `ok | invalid | transient | revoked`; malformed = invalid; Google's body
`productId` must equal the embedded one. Subscriptions: `originalRef` = `fake~<productId>~<token|none>`, so references
differing only in times are renewals of one subscription.

**`GET /v1/me/entitlements`**: `{ commerceToken, firstClassPass, firstClassUntil, productId | null, evaluatedAt }`; the
token is created on first read (`INSERT ... ON CONFLICT (player_id) DO NOTHING`, then SELECT; random UUID v4, never derived
from the uid); 404 `player_not_found` before `PUT /v1/me`.

**`POST /v1/purchases`** (signed-in, version gate, rate limit; `Idempotency-Key` accepted and ignored). Strict body:
`{ store: "apple", productId, transactionId, jws? }` or `{ store: "google", productId, purchaseToken }`; per-field
patterns and lengths (Apple id `^[A-Za-z0-9._~-]{1,256}$`, Google token `^[A-Za-z0-9._~:-]{1,1024}$` (as built; 4096 in the first draft would overflow a btree entry), jws <= 12 KB,
unused until P2). Flow:
1. 404 if no player. `STORE_VERIFIER=none` → 503 `store_unavailable`.
2. Verify outside any transaction. transient → 503 + `Retry-After`; invalid → 422 `purchase_invalid`; `productId` differs
   from the body → 422 `purchase_invalid`; revoked → 422 `purchase_revoked`.
3. One `PlayerBalance.update` (player row locked first), all writes in `src/purchases/purchase-grant.ts`:
   a. Product read inside the callback; unknown or not sellable here → step with no change, response `status: pending`.
   b. Ownership: `tx.accountToken` present and not the caller's `commerceToken` → 409 (returned, not thrown).
   c. `INSERT store_transactions ... ON CONFLICT (store, transaction_ref) DO NOTHING RETURNING`; no row → SELECT it: same
      player = replay (no `change`, so no version bump; `status: granted, replayed: true`, the recorded grant, current
      progress); another player = 409.
   d. hint_pack: posting `{ account: "hints", kind: "store_purchase", ref: "<store>:<transactionRef>", delta: hints }`.
   e. first_class_pass: `INSERT store_subscriptions ... ON CONFLICT (store, original_ref) DO UPDATE SET expires_at =
      GREATEST(old, new), status = 'active', last_event_at = GREATEST(...) WHERE store_subscriptions.player_id =
      EXCLUDED.player_id RETURNING`; no row → 409 (rolls back c). Then `firstClassUntil` = MAX(expires_at) over the
      player's `active` + `grace` subscriptions (the only write path), as a `change`.
   f. A residual 23505 maps to 409 (as `ugs-link.service.ts` does). Order under the lock: transactions, subscriptions,
      recompute.
4. After commit, Google: `acknowledge` (also on a replay, until P4's sweeper); a failure is logged.

Balance guard (P-C only): new rule "writes store_transactions or store_subscriptions" (Drizzle and raw SQL, like the TRIPS /
AWARDS rules), `PURCHASE_WRITERS = [src/purchases/purchase-grant.ts]`, stale-entry and seeded-violation tests.

## Tests

P-C: grant hints; replay (no version bump, nothing paid); concurrent same tx, same player (one grant); two players same tx
concurrently (one grant, one 409); token mismatch 409; absent token → first caller owns, then a second player 409;
invalid; transient (503, Retry-After, nothing written); revoked; unknown product → pending, then the product is added and a
resend grants; retired product still grants; demo product in production → pending; Pass sets `firstClassUntil`,
`progress.firstClassPass = true`, and a following Round pays +50% (R2); two renewals = one subscription row, two transaction
rows, expiry never moves back, one version bump per grant; two different Pass subscriptions → MAX; mirror enqueued at the new
version; account deletion cascades, a re-created account's token differs and the old receipt answers 409 (R4); `none` → 503;
config refuses `fake` in production and with a real project; fake parser with dotted ids; entitlements create-once race.
P-B: CRUD, version conflict, kind/demo immutable, audit rows, 403 for a player, retired and demo-in-production hidden, seed
idempotent and refused in production.

## Ownership

| Slice | Files |
|---|---|
| P-A | `docs/openapi.yaml`, `src/db/schema.ts`, `src/db/enums.ts`, `src/balance/ledger-kinds.ts`, `drizzle/0020_*` + meta, `src/config/config.module.ts`, `.env.example`, `src/app.module.ts`, `src/store/{store.module,catalog,demo-products}.ts`, `src/purchases/purchases.module.ts`, `test/store-helpers.ts`, `test/schema-parity.ts` (+ its tests), config tests |
| P-B | `src/store/*` except P-A's three files, `scripts/store-seed-demo.mjs`, `package.json` (script only), `test/store-products*.test.ts` |
| P-C | `src/purchases/*` except the module skeleton's registration, `test/purchases*.test.ts`, `test/balance-guard.test.ts` |
| Lead (integration) | drop `x-planned` marks, move codes into `src/common/errors.ts`, route counts in `test/api.test.ts`, `npm run contracts:write`, `docs/TASKS.md`, `docs/ARCHITECTURE.md` Purchases, README env table, reply to Unity |

## Wave P-D: staff read of purchases and entitlements (approved with changes, revised, 2026-11-04)

For the website admin's Phase 2 (`../docs/briefs/website-monetization-admin.md`). User order 2026-11-04: P-D first, then P-E
Miles packs (U11, confirmed by the user here). Read-only; no migration, no balance write, no new error code. Reviews:
senior-lead and backend-expert, both "approve with changes"; every finding is folded in below. Default taken (reviewers'
recommendation, user may overrule): **staff do not see `commerceToken`** (the ownership key stays with its owner).

Both routes: `@Roles("admin")` + `@SkipClientVersion()`, as `store-admin.controller.ts`. The identity field is `principal`
(as `adminView` in `accounts.controller.ts`), never `playerId`.

### 1. `GET /v1/admin/store/purchases`

- Strict query (`z.strictObject`; unknown key, empty value or repeated key → 400 `invalid_request`):
  `player` (string <= 200, refined with `uidOfAccountPrincipal(value, config.firebaseProjectId) !== undefined`; another
  project's principal → 400), `productId` (`PRODUCT_ID_PATTERN`), `store` (`z.enum(STORES)`), `transactionRef` (Apple id
  pattern of `POST /v1/purchases`) and `orderId` (`^[A-Za-z0-9._:-]{1,128}$`) for exact lookup, `cursor`, `limit`
  (`^[0-9]{1,3}$`, then 1..100, default 50).
- Order `id DESC` (identity PK, insert order), keyset `id < lastId` — **the media list pattern** (`media.service.ts:66-147`),
  not `created_at`. Cursor = base64url(`sp1.<lastId>.<f>`), `f` = first 22 base64url chars of SHA-256 over the canonical JSON
  `[player, productId, store, transactionRef, orderId]` (nulls for absent). Decode, compare `f` with this request's filters,
  re-encode and refuse non-canonical spellings; anything else → 400 with the media message. Cursor pattern
  `^[A-Za-z0-9_-]{1,100}$`, same bound in openapi.
- A well-formed but unknown player or product → 200 `{ purchases: [] }` (never 404; reveals nothing). A deleted player's rows are
  gone (R4); `store_claims` is never exposed. Limit, documented: a row whose transaction commits after a page passed its id
  appears on a fresh traversal.
- Response `{ purchases: [StaffStorePurchase], nextCursor: string | null }`. `StaffStorePurchase = { id, store, principal,
  productId, kind, environment, transactionId | null (Apple only, as stored), orderId | null, tokenFingerprint | null (Google
  only: first 12 hex of sha256 of the purchase token; the raw token is never returned), originalFingerprint | null (same rule
  for `original_ref`; Apple returns `originalTransactionId` as stored instead), purchasedAt, grant, createdAt }`.
- `grant` is a tagged union with a discriminator: `{ type: "hints", hints }` | `{ type: "first_class_pass", until }`. Documented as
  **open**: P-E adds `{ type: "miles", miles }` (with a `granted_miles` column and the kind CHECK change in 0021) and a new `kind`
  value; consumers must show an unknown type or kind raw and never fail.

### 2. `GET /v1/admin/store/players/{principal}/entitlements`

- `@Param("principal", AccountPrincipalPipe)` (moved to a small shared module if importing it from the controller is awkward);
  empty strict query.
- A separate service method (never `EntitlementsService.get`, which creates the token row): one
  `withTransaction(fn, { isolationLevel: "repeatable read", accessMode: "read only" })` (the `READ_SNAPSHOT` of
  `content-admin.service.ts`). In order: player (missing → 404 `player_not_found`), subscriptions ordered by `expires_at DESC,
  original_ref`, `evaluatedAt = databaseNow(tx)`, `firstClassPass = hasFirstClassPass(player.firstClassUntil, evaluatedAt)`,
  `productId` of the current Pass by the same rule as `/v1/me/entitlements`.
- Response `{ principal, firstClassPass, firstClassUntil, productId | null, evaluatedAt, hasStoreAccount, subscriptions: [{ store,
  originalTransactionId | null (Apple), originalFingerprint | null (Google), productId, status (full enum), expiresAt,
  lastEventAt, createdAt }] }`. No `commerceToken`.

### 3. Store product title (website finding)

`PUT /v1/admin/store/products/{productId}`: `title` is trimmed, then must be 1..100 characters with no control characters
(U+0000-U+001F, U+007F-U+009F) → else 400 `invalid_request`. Documented in openapi.

### Contract and tests

openapi **0.21.0**, both operations built (no `x-planned`), `additionalProperties: false` on `StaffStorePurchase`,
`StaffStorePurchaseList`, `StaffEntitlements`, `StaffStoreSubscription`; `id` integer >= 1; nullable strings as above;
`grant` `oneOf` + `discriminator` on `type`. `test/openapi.e2e.test.ts`: real-response validation for both routes next to the
existing "admin routes: staff responses validate against the spec" case (a hint-pack row, a Pass row, a 400 cursor, a 404), and
the strictness `rejects(...)` cases (extra field; a `grant` with both shapes). `test/api.test.ts` count 59 → 61 (58 guarded, 38
admin).

Tests (`test/store-purchases-admin.e2e.test.ts`): paging with `limit=1` asserts the exact id sequence over several pages; a cursor
replayed under each other filter set → 400; an edited (non-canonical) cursor → 400; repeated keys and empty values → 400; another
project's principal → 400; unknown principal → 200 empty; exact lookup by `transactionRef` and by `orderId`; a deleted player's
rows absent and no tombstone fields anywhere; Google rows never contain the raw token; entitlements: 404 unknown, a player with
no store account (`hasStoreAccount: false`, `store_accounts` count unchanged), expired vs active subscriptions,
`setTestDatabaseClockSkew` flips `firstClassPass` while `firstClassUntil` stays; 401, 403 for a player and for an admin without
a verified email, on both routes; title trimming and control-character refusal.

### Ownership and integration

| Who | Files |
|---|---|
| Implementer | `src/store/store-purchases-admin.controller.ts`, `src/store/store-purchases-admin.service.ts`, `src/store/store.module.ts`, `src/store/store-admin.controller.ts` + `store-catalog.service.ts` (title rule only), a shared principal pipe module if needed (and its import in `accounts.controller.ts`), `docs/openapi.yaml`, `test/api.test.ts`, `test/openapi.e2e.test.ts`, `test/store-purchases-admin.e2e.test.ts`, `test/store-products.e2e.test.ts` (title tests) |
| Lead | `npm run contracts:write`, `docs/TASKS.md`, `docs/ARCHITECTURE.md` Purchases (staff read), the website brief's Phase 2 updated to API 0.21.0 with the real shapes, then the message to the website session |

Verification: `npm run typecheck`, `npm test`, `npm run test:e2e` from PowerShell (uppercase `H:`), one full run.

## Next waves

P-E Miles packs (U11) → P2 Apple adapter (`@apple/app-store-server-library`, sandbox key) → P3 Google adapter (+ acknowledge sweeper) → P4 ASSN v2 /
RTDN, refunds (hint clawback clamped at 0, D6), grace/expiry, Get Notification History → ads + Pass hint grants (brief) →
P5 SP boosts → final store ids replace the demo rows.
