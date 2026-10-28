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
from the host's environment/secret manager) · user uploads/multer · socket.io · nodemailer/Twilio/OTP
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
  S3 compatibility on (it can only be enabled when a zone is created). Whether the backend shares that
  zone (under its own key prefix) or gets its own zone is decided with the first slice that stores files.
- Private by default: no public pull zone for originals; serve through authenticated routes or
  short-lived signed URLs. A public CDN pull zone only for content that is meant to be public.
- The read-write Storage Zone Password (S3 secret) comes from the host environment, never the repo or
  logs; not the Bunny account API key. No zone creation or other Bunny account change without user sign-off.
- Verify with a probe like the website's `npm run bunny:check` (upload one random object, compare bytes, delete).

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
