# Purchases (Phase 4), wave P: catalog, purchase route, fake store

Status: **approved with changes, revised** (2026-11-04). Reviews: senior-lead, backend-expert, game-domain-expert (all
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
- R4 **Account deletion is final**: store token and purchase rows cascade; old receipts answer 409 for a new account.
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
patterns and lengths (Apple id `^[A-Za-z0-9._~-]{1,256}$`, Google token `^[A-Za-z0-9._~:-]{1,4096}$`, jws <= 16 KB,
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

## Next waves

P2 Apple adapter (`@apple/app-store-server-library`, sandbox key) → P3 Google adapter (+ acknowledge sweeper) → P4 ASSN v2 /
RTDN, refunds (hint clawback clamped at 0, D6), grace/expiry, Get Notification History → ads + Pass hint grants (brief) →
P5 SP boosts → final store ids replace the demo rows.
