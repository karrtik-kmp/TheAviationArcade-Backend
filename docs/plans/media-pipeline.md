# Implementation plan: media pipeline and CDN delivery (Backend ADR-0001)

Status: **approved** (user, 2026-11-03: contract as proposed; publish needs a licence name and, when `creditRequired`, a credit; source URL optional; roles per ADR-0002). Tasks are tracked in this file; `docs/TASKS.md` row 5.R
points here. Work happens on `main` in `H:\Work\TheAviationArcade\Backend` (no worktrees); each checkpoint ends in a
review, a commit and a push to `origin`.

## Overview

Staff upload game images through the backend; the backend checks and hashes them, stores each file once in the shared
Bunny zone under `backend/content/photos/<sha256>.<ext>`, and records a **media item** (stable `med-<n>` id, version,
licence fields, state `unverified` → `published` → `withdrawn`). Content items reference a media item. Callers that are
allowed to see an image get an `ImageRef` with a 24-hour HS256-signed Bunny CDN link. Everything is built and tested
against `MemoryBlobStore`; the real Bunny pull zone, token key and Edge Rules are created only with the user's sign-off
(task 10).

Sources: [ADR-0001](../adr/ADR-0001-image-storage-and-delivery.md), [ADR-0002](../adr/ADR-0002-role-based-access.md) (roles), the media API contract proposed on 2026-11-03 (task
0 records it), [releases-and-dealing.md](../design/releases-and-dealing.md) §1–§2.

## Architecture decisions (settled)

- Media item = stable id + version; each version = one content-addressed file. Items reference `mediaId`; releases (later)
  freeze `mediaId` + version + sha256. A new version returns the item to `unverified`.
- The storage path is never exposed in any API response; `ImageRef.url` is opaque and expires (`expiresAt`); `sha256` is
  the device cache key.
- Upload: required `Idempotency-Key`, claimed by a unique-constraint insert in the same transaction as the media row; put
  + read-back verify before the transaction (an orphan file is harmless).
- Players get links only for images their dealt Flight uses (wave B3, not this plan); the website gets published images
  through a batch route; unpublished ids are absent, never 404/403, so existence does not leak.
- One new error code `media_invalid` (422); everything else reuses existing codes.
- **Roles (ADR-0002):** `photographer` uploads and manages only its own media items (versions, licence, status); `admin`
  does everything, including publish, withdraw, linking items and deciding roles. Guards read `account_roles` per
  request; `STAFF_EMAILS` is retired.
- Clocks: database clock for every stored timestamp and the link expiry base (`src/database/clock.ts`).

## Dependency graph

```
T0 contract (x-planned)        T1 pure: image sniffer + CDN signer
        \                      /
         T2 schema 0016 (media tables, item link column, audit actions)
                 |
         T3 upload (create)
                 |
         T4 new version, licence edit, publish/withdraw
            /              \
   T5 staff list/get        T6 link a content item to media
   (preview ImageRef)               |
            \                       |
             T7 website batch GET /v1/media
                 |
         T8 docs + config surface      T9 releases/dealing use ImageRef (wave B2/B3, out of scope)
                 |
         T10 live Bunny setup (user sign-off)
```

## Task list

### Phase 0: roles (ADR-0002) — before any media route

- [ ] **R-a: `account_roles` schema and the roles guard** — M
  - Migration **0016**: `account_roles` (principal, role `player|photographer|admin`, state
    `pending|active|rejected|revoked`, requested_at, decided_at, decided_by, note; unique (principal, role)); audit actions
    `role_request`, `role_approve`, `role_reject`, `role_grant`, `role_revoke`; TS lists + S5 parity. `RolesGuard` +
    `@Roles(...)` (verified email for photographer/admin; admin implies photographer), one indexed lookup per request.
    Replace `@StaffOnly` with `@Roles("admin")` on every existing admin route; remove `STAFF_EMAILS` from config, README,
    `.env.example` and tests (tests seed roles instead). `GET /v1/admin/me` returns the caller's roles.
  - Acceptance: every existing admin e2e passes with seeded admin roles; a verified email with no role is 403; an
    unverified email with an active admin row is 403; a revoked role is 403 on the next request; no code path reads
    `STAFF_EMAILS`.
  - Verify: typecheck, unit, e2e; `db:generate` second run no changes.
  - Files: `src/db/schema.ts`, `src/db/enums.ts`, `drizzle/0016*`, `src/auth/staff.ts` (→ roles guard),
    `src/config/config.module.ts`, admin controllers' decorators, tests. Depends on: none.
- [ ] **R-b: role registration and decisions** — M
  - `PUT /v1/me` issues `player` (idempotent); `POST /v1/me/roles/photographer` (request → `pending`; repeat is a no-op;
    after `rejected`/`revoked` a new request is allowed); admin `GET /v1/admin/role-requests?state=pending`, admin
    `POST /v1/admin/accounts/{principal}/roles/{role}/approve|reject|revoke` and grant of `admin`; one audit row each;
    an admin cannot revoke their own last admin role (no lock-out).
  - Acceptance: a client can never obtain `photographer` or `admin` without an admin decision; concurrent decisions on
    one request give one winner (`version_conflict` or state check); openapi documents every route and code.
  - Files: new `src/accounts/*`, `src/players/players.service.ts` (player role at signup), openapi, tests. Depends on: R-a.
- [ ] **R-c: `npm run roles:grant -- <uid> <role>` operator command** — S
  - Direct database write for the very first admin; refuses a uid that is not a Firebase uid shape and any principal of
    another Firebase project; writes the same audit row as an admin grant (actor `operator:<os user>`).
  - Files: `scripts/roles-grant.mjs`, `package.json`, README. Depends on: R-a.

### Checkpoint 0 (after R-a–R-c)

- [ ] green suites; independent review (security focus: no privilege without a decision); commit; push; message the
  website session (its `STAFF_EMAILS` rule is superseded for backend routes).

### Phase 1: foundation

- [ ] **T0: Record the media contract as `x-planned`** — S
  - Add the staff routes (`POST /v1/admin/media`, `POST .../{mediaId}/versions`, `PATCH .../{mediaId}`,
    `POST .../publish`, `POST .../withdraw`, `GET /v1/admin/media`, `GET .../{mediaId}`,
    `PUT /v1/admin/content/{module}/items/{id}/media`), `GET /v1/media?ids=`, schemas `MediaItem`, `MediaLicence`,
    `ImageRef`, and `media_invalid` in `x-planned-enum` to `docs/openapi.yaml`, each operation `x-planned: true` with a
    note.
  - Acceptance: the parity test treats every new operation as planned (each answers 404 `not_found` today); no built
    route changes; `info.version` unchanged.
  - Verify: `npm run test:e2e -- openapi` green; `npm test` green.
  - Files: `docs/openapi.yaml`. Depends on: none.
- [ ] **T1: Pure image sniffer and CDN link signer** — S
  - `src/content/media/image-sniff.ts`: JPEG (SOI + SOFn dimensions) and PNG (signature + IHDR) only; returns type,
    width, height or a reason. `src/platform/cdn-signer.ts`: Bunny advanced token `HS256-` + base64url(HMAC-SHA256(key,
    path + expires [+ sorted signed params])), per-file path, no IP, query form `?token=&expires=`.
  - Acceptance: sniffer rejects truncated, spoofed-extension and > 4096 px images; signer matches fixed test vectors built
    from Bunny's documented algorithm (cite the doc URL in the test) and never signs a path outside
    `/backend/content/photos/`.
  - Verify: unit tests (added to the `vitest.config.ts` include list).
  - Files: the two sources, two tests, `vitest.config.ts`. Depends on: none. **Parallel with T0.**
- [ ] **T2: Schema and migration 0017** — M
  - Tables `media_items` (id, state, current_version, licence fields, created/updated by and at), `media_versions`
    (media_id, version, sha256, content_type, byte_size, width, height, blob_key, created_at/by; UNIQUE (media_id,
    version)), `media_upload_keys` (idempotency key PK, principal, sha256, media_id, created_at),
    `content_items.media_id` (FK, NULL), `media_items.owner` (uploader principal). Audit actions `media_upload`, `media_edit`, `media_publish`, `media_withdraw`,
    `content_media_link`. TS lists in `src/db/enums.ts`; S5 parity tests.
  - Acceptance: generated with `npm run db:generate` (second run: no changes); CHECK lists equal the TS lists; existing
    tests green.
  - Verify: `npm test`, `npm run test:e2e`.
  - Files: `src/db/schema.ts`, `src/db/enums.ts`, `drizzle/0017*`, parity test expectations. Depends on: R-a (migration
    order); T3 needs it.

### Checkpoint A (after T0–T2)

- [ ] typecheck, unit, e2e green; independent review of T0–T2; commit per task; push.

### Phase 2: staff media

- [ ] **T3: Upload a new media item** — M
  - `POST /v1/admin/media` (raw bytes through a route-scoped body reader, 5 MB, `@Roles("photographer")` (admin
    included), required
    `Idempotency-Key`). Sniff → hash → `put` `content/photos/<sha256>.<ext>` → `get` and compare the hash → one
    transaction: claim the key (unique insert), insert item + version 1 (`unverified`), audit row.
  - Acceptance: 201 `MediaItem`; same key + same bytes → 200 replay with the same item; same key + other bytes → 422
    `idempotency_key_reused`; concurrent duplicate → exactly one item; bad image → 422 `media_invalid`; > 5 MB → 413;
    storage down → 503 `storage_unavailable` and nothing written; no response contains the storage path.
  - Verify: e2e `test/media.e2e.test.ts` against `MemoryBlobStore`; the route moves from `x-planned` to built in openapi.
  - Files: `src/content/media/{media.module,media.controller,media.service}.ts`, `src/app.setup.ts`,
    `src/app.module.ts`, `docs/openapi.yaml`, `src/common/errors.ts`, the test. Depends on: T1, T2.
- [ ] **T4: New version, licence edit, publish, withdraw** — M
  - `POST .../{mediaId}/versions?expectedVersion=` (same pipeline; back to `unverified`; identical bytes → 200
    `changed: false`), `PATCH .../{mediaId}` `{ version, licence?, note? }`, `POST .../publish` and `.../withdraw`
    `{ version }`. Refusals returned, not thrown, inside transactions (`ExpectedRollback` pattern).
  - Acceptance: stale version → 409 `version_conflict` and nothing changes; publish without a licence name, or without a
    credit when `creditRequired`, → 422 `content_invalid`; publishing a published item → 409 `nothing_to_publish`; every
    change writes one audit row with a field diff; licence text stored verbatim (trim only). A photographer may add
    versions and edit the licence of **its own** items only (others: 404, existence not leaked); publish and withdraw
    are `@Roles("admin")`.
  - Verify: e2e in the same file; openapi moves these routes to built.
  - Files: media service/controller, openapi, the test. Depends on: T3.

### Checkpoint B (after T3–T4)

- [ ] green suites; independent review; commit; push.

### Phase 3: reading images

- [ ] **T5: Staff list and get with a preview link** — M
  - `GET /v1/admin/media?state=&cursor=&limit=` (newest first, `limit` <= 100, opaque cursor) and
    `GET .../{mediaId}` (item, version history, preview `ImageRef` signed in any state). Photographers see only their
    own items; admins see all. Config `BUNNY_CDN_HOST` and
    `BUNNY_CDN_TOKEN_KEY` (validated; required only to sign; without them a preview has `url: null` and a documented
    reason, so local runs work).
  - Acceptance: pagination is stable under inserts; `ImageRef.expiresAt` = database now + 24 h; the URL verifies with the
    T1 signer; the key never appears in logs or responses.
  - Verify: e2e; config unit tests.
  - Files: media controller/service, `src/config/config.module.ts`, `.env.example`, tests. Depends on: T1, T4.
- [ ] **T6: Link a content item to a media item** — S
  - `PUT /v1/admin/content/{module}/items/{id}/media` (`@Roles("admin")`) `{ mediaId | null, expectedVersion }` through the A1 edit service
    (module lock, version bump, `content_media_link` audit); items list and export gain a `mediaId` column (import
    ignores it).
  - Acceptance: stale version 409; unknown media 422 `media_invalid`; unknown item 404; an import never changes
    `media_id`; a client sheet still replays only when no staff write followed it (the link counts as a staff write).
  - Verify: e2e in `test/content-items-edit.e2e.test.ts`.
  - Files: `src/content/content-item-edit.service.ts`, `content.controller.ts`, `content.service.ts` (list/export),
    openapi, the test. Depends on: T2. **Parallel with T5** (disjoint files).
- [ ] **T7: Website batch read** — S
  - `GET /v1/media?ids=` (signed-in caller, at most 50 ids, `published` only; others absent), `X-Client: web` accepted
    as today.
  - Acceptance: unpublished, withdrawn and unknown ids are absent (no 404); response order follows `ids`; links signed per
    file; strict query validation.
  - Verify: e2e.
  - Files: media controller/service, openapi, the test. Depends on: T5.

### Checkpoint C (after T5–T7)

- [ ] green suites; independent review over T5–T7; commit; push; message the website and Unity sessions with the
  contract (ADR-0001 action item 6).

### Phase 4: documentation and live setup

- [ ] **T8: Docs and config surface** — S
  - README env table (`BUNNY_CDN_HOST`, `BUNNY_CDN_TOKEN_KEY`), ARCHITECTURE "File storage" (pull zone, token auth, Edge
    Rules, media table), `docs/TASKS.md` row 5.R and the verification record, design doc §2 cross-references.
  - Verify: links resolve; no secret values.
  - Depends on: T7.
- [ ] **T10: Live Bunny setup — user sign-off required** — S (human-gated)
  - With the user's explicit go-ahead: create the pull zone on `aviation-arcade-website`, enable advanced token auth,
    add Edge Rules (block outside `/backend/content/photos/`; edge cache 1 year; browser cache 24 h), set
    `BUNNY_CDN_TOKEN_KEY`/`BUNNY_CDN_HOST` in the local `.env` (never committed), run `npm run bunny:check`, then upload
    one test image and curl: unsigned → 403, signed → 200, signed other prefix → 403, expired → 403. Record the results.
  - Depends on: T5 (signer + preview), user sign-off.

Out of scope here (later waves): T9 — `ImageRef` on dealt Trips and Rounds (R4), releases freezing media versions (R2),
Plane of the Day.

## Parallel lanes

- Phase 0 first (R-a owns migration 0016; R-b ∥ R-c after it). T0 ∥ T1 can run beside Phase 0 (disjoint files).
- T2 after R-a (owns migration 0017).
- T5 ∥ T6 (disjoint files).
- Independent of this plan and safe to run beside Phase 1–2: design slices **R0** (pure answer check) and **R1**
  (commercial Card gate), which touch `src/rules/` and `src/content/documents/` only.
- Serial: anything touching `drizzle/`, `src/db/schema.ts`, or the route-count/openapi tests at the same time.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Bunny token formula details (e.g. whether `token_path` sits in the signed data) differ from our reading | High: every link 403 | Per-file tokens without `token_path`; test vectors from the docs; T10 curl tests before anyone relies on it |
| Bunny S3 API is a public preview | Medium | Keep the BlobStore seam; HTTP Storage API adapter as fallback; `bunny:check` before use |
| `MemoryBlobStore` is per process: files vanish on restart locally | Low (dev only) | Re-upload; T3 tests run in one process |
| Withdrawn image stays reachable up to 24 h | Medium | Documented in ADR-0001; key rotation as the emergency stop |
| Token auth turns off IPv6 on the pull zone | Low | Accepted in ADR-0001 |
| Hot files (openapi, errors, migrations, route-count test) collide between parallel agents | Medium | Ownership per task; T0 lands first; serial merges |
| A signing key leak exposes the shared zone | High | Key only in backend env; per-file tokens; Edge Rule fence on the game folder |

## Open questions

None. Settled 2026-11-03: contract approved; licence name always and credit when `creditRequired` (source URL
optional); photographers upload, admins publish; roles per ADR-0002.
