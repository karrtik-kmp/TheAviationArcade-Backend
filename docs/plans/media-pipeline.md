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
  freeze `mediaId` + version + sha256. A new upload or licence edit changes only the draft version; the published
  version and its credit stay live until an admin publishes the draft (user, 2026-11-03).
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

- [x] **R-a: `account_roles` schema and the roles guard** — M
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
- [x] **R-b: role registration and decisions** — M
  - **One lock, re-checked actor, revision fence.** Every role-changing transaction (request, approve, reject, admin grant,
    revoke, signup `player`, the operator command) first takes `pg_advisory_xact_lock(hashtextextended('account-roles', 0))`,
    then re-reads that the actor still holds an active `admin` row (403 `forbidden` otherwise; the operator is exempt), then
    writes with `UPDATE ... WHERE principal = $p AND role = $r AND state = <required> AND revision = $rev RETURNING`.
    Zero rows: 404 `not_found` if no row, else 409 `version_conflict` naming the current state and revision. Every
    transition bumps `revision` and stamps `decided_at` from the database clock.
  - **Legal transitions only.** photographer: pending→active (approve), pending→rejected (reject), active→revoked (revoke),
    rejected/revoked→pending (only the account's own new request). admin: (none)→active or revoked→active (grant, or
    operator), active→revoked (revoke). player: issued at signup, never decided or revoked in this wave (user, 2026-11-03).
    Anything else: 409 `version_conflict`.
  - **At least one active admin, always.** Revoking `admin` is refused with 409 `version_conflict` ("would leave no active
    admin") when fewer than 2 active admins exist, checked under the lock. Self-revoke is allowed while another admin
    remains (user, 2026-11-03).
  - **Routes.**
    - `PUT /v1/me` issues `player` on every call (not only on create), in its own short transaction after
      `PlayerBalance.open`, under the role lock: `INSERT ... ('player','active', requested_at = decided_at = db now,
      decided_by = 'system:signup') ON CONFLICT DO NOTHING RETURNING`; one `role_grant` audit row only when a row was
      inserted. Existing players get the role on their next sign-in (no backfill); a revoked `player` is never reactivated.
      Nothing requires `@Roles("player")` in this wave.
    - `POST /v1/me/roles/photographer` (fixed role, strict empty body): needs a verified email (403 otherwise), no player
      row. Under the lock: `INSERT ... ('photographer','pending', requested_at = db now, email = token email) ON CONFLICT
      DO UPDATE SET state = 'pending', ..., revision = revision + 1 WHERE state IN ('rejected','revoked') RETURNING`. No row
      returned: a no-op, 200 with the current state. Audit `role_request` only when a row changed.
    - `GET /v1/me/roles` (any signed-in caller): own rows `{ role, state, revision, requestedAt, decidedAt }`.
    - Admin: `GET /v1/admin/role-requests?state=pending&cursor=&limit=` (oldest first; shows the requester's email, revision);
      `POST /v1/admin/accounts/{principal}/roles/photographer/approve|reject` and `/roles/{photographer|admin}/revoke`
      with strict `{ revision, note? }`; `POST /v1/admin/accounts/{principal}/roles/admin/grant` with `{ note? }` (grant is
      admin only: photographer always goes through request and approval).
  - **`{principal}` validation** in one shared helper (also used by R-c): URL-decoded, exactly
    `firebase:<configured FIREBASE_PROJECT_ID>:<uid>`, uid 1-128 chars, no surrounding whitespace, no `:`, `/` or control
    characters; anything else 400 `invalid_request`.
  - **Email on a request** (user, 2026-11-03): the requester's verified email is stored on the photographer row, shown to
    admins only, never used for authorisation; `DELETE /v1/me` clears it (role rows and audit rows otherwise stay,
    ADR-0002 decision 1; the openapi `DELETE /v1/me` description says so).
  - **Audit:** target = principal, `detail = { role, from: { state, revision }, to: { state, revision }, note }`, written in
    the same transaction; nothing on a refusal or no-op. The row's `note` is overwritten per decision, so the audit row is
    the history.
  - Acceptance (tests): request body or query carrying a role or state is 400; a pending row grants nothing (403 on an
    admin probe and a unit guard test); two admins revoking each other concurrently leave exactly one admin; an admin
    revoked mid-request cannot commit a decision (403, nothing written); a stale-revision approve after reject and
    re-request is 409; a request never touches an active row; N concurrent `PUT /v1/me` give one `player` row and one audit
    row; `PUT /v1/me` never reactivates a revoked `player`; `DELETE /v1/me` leaves roles and audit rows and clears the email;
    a revoke is effective on the next request.
  - Files: new `src/accounts/*` (role store with the lock and transitions, controllers, principal helper),
    `src/players/players.service.ts`, `src/app.module.ts`, `src/common/errors.ts` (only if a code is added; none planned),
    `docs/openapi.yaml`, `test/api.test.ts` (route count), `test/openapi.e2e.test.ts`, new role e2e tests. Not
    `schema.ts`/`enums.ts`: the schema lands in 0016 with R-a. Depends on: R-a committed.
- [x] **R-c: `npm run roles:grant -- <uid> --yes` operator command** — S
  - First admin and recovery only (user, 2026-11-03): accepts only `admin`; refuses when any active admin exists; builds
    the principal from the configured `FIREBASE_PROJECT_ID` with the shared principal helper (refuses a full principal of
    another project, a bad uid, and the `demo-airplane-games` project when `APP_ENV=production`); prints the target
    database host and name and requires `--yes`; a `revoked` admin row becomes `active` (update, not a second insert).
  - Runs the compiled role store from `dist/` (the `scripts/bunny-check.mjs` pattern: build, `loadEnvFile`, import), so the
    lock, revision bump and audit row are the same code as the API; actor `operator:<os user>` cut to 256 chars.
  - Acceptance tests: refuses wrong project, bad uid, any role but admin, an existing active admin, a missing `--yes`;
    writes the same audit shape as an API grant.
  - Files: `scripts/roles-grant.mjs`, `package.json`, README. Depends on: R-b's role store (same lane, after R-b).

### Checkpoint 0 (after R-a–R-c)

- [x] green suites; `code-reviewer` (security focus: no privilege without a decision, last-admin invariant, stale
  decisions); commit; push; message the website session (its `STAFF_EMAILS` rule is superseded for backend routes;
  `GET /v1/me/roles` and the request route for its photographer screens).

### Phase 0b: role follow-ups (user, 2026-11-03, from the website's adoption of ADR-0002)

- [x] **R-d: role block, typed admin email, email edit** — M (gate: senior-lead + backend-expert, APPROVE WITH CHANGES,
  all folded in below)
  - **Why.** The website moves its staff screens fully to backend roles (website session, 2026-11-03). User rulings:
    (1) an admin row shows an email **typed at grant**, display only, never used for authorisation, and an admin can
    **correct** it later; (2) "block from role" is a real, lasting photographer state; (3) block and admin stay apart:
    an account with an active `admin` row cannot be photographer-blocked (revoke admin first), and admin cannot be
    granted (API or `roles:grant`) to an account whose photographer row is `blocked`; both 409 `version_conflict`,
    checked under the role lock. The guard's admin-implies-photographer rule is unchanged.
  - **Sequencing gate.** T3 (with its review fixes) is committed and pushed before R-d or T4 starts. R-d alone owns
    the schema in this lane: T4 changes no migration, `src/db/schema.ts` or `src/db/enums.ts` (if it needs one it stops
    and the lead serialises it after 0018). Each slice is committed separately with explicit `git add <paths>`.
    `docs/openapi.yaml` and `test/api.test.ts` are shared: each implementer edits only its own operations; the lead
    does the version bump (0.15.0), changelog and route count, then runs the openapi parity e2e on the merged tree.
  - **Migration 0018** (generated with no other schema edit pending; 0016/0017 are immutable). Expected SQL, inspected
    before use: DROP/ADD `account_roles_state_check` (`ROLE_STATES` + `blocked`), DROP/ADD `admin_audit_action_check`
    (+ `role_block`, `role_unblock`, `role_email_edit`), ADD COLUMN `account_roles.grant_email` text NULL, two rule
    CHECKs written with `=` (not `IN`): `state <> 'blocked' OR role = 'photographer'` and `grant_email IS NULL OR
    (role = 'admin' AND char_length(grant_email) BETWEEN 3 AND 320)` (same limit as `request_email`), and a partial
    index `account_roles_blocked_queue (requested_at, principal) WHERE state = 'blocked'`. `account_roles_decided_check`
    is unchanged (it already requires `decided_*` for every non-pending state). Safe on existing rows: nothing is
    `blocked`, every `grant_email` is NULL. No down migration: reverting needs a new migration, with `blocked` rows first
    set to `revoked`. Parity: `blocked` and the three audit actions in the TS lists; both rule CHECKs added to
    `RULE_CHECKS` in `test/schema-parity.ts`, with behavioural tests (a blocked admin row and `grant_email` on a
    photographer row are refused; a blocked row with NULL `decided_at` is refused).
  - **Block / unblock** (photographer only, fixed routes, never the `:role` route, so the last-admin invariant cannot
    break): `POST /v1/admin/accounts/{principal}/roles/photographer/block` strict `{ revision, note? }`, from `pending`,
    `active`, `rejected` or `revoked` to `blocked`; `.../unblock` `{ revision, note? }`, `blocked` to `revoked` (the
    account may request again; the openapi says a `revoked` after unblock does not mean it was ever approved). Own store
    methods with a set of from-states, fenced `state = <current> AND revision = $rev`; same lock, actor re-check,
    404 (no photographer row) / 409 rules and audit shape as R-b. Revoke, approve or reject of a `blocked` row is 409.
  - **Request while blocked:** `RequestOutcome` gains `{ ok: false, error }`. Under the lock, `before.state ===
    'blocked'` gives 403 `forbidden` ("blocked from this role"), no write, no audit; the post-upsert re-read repeats the
    check defensively. `blocked` is NOT added to the unlocked pre-read short-circuit. A blocked row never passes: the
    guard and `roleBodyReader` read `state = 'active'` only.
  - **Typed email:** one shared `normalizeTypedEmail()` in `src/accounts/` (trim, lowercase, one `@`, no whitespace or
    control characters, 3-320 code points, else 400 `invalid_request`), used by the controller and by
    `scripts/roles-grant.mjs` through `dist/` (`--email X` or `--email=X`; a bad value exits 2 before the database is
    contacted). Typed emails are lowercased; token emails (`request_email`) are stored as the token gives them, a
    deliberate difference. `POST .../roles/admin/grant` takes strict `{ note?, email? }`: insert `email ?? null`; a
    re-grant from `revoked` replaces it when given and keeps it otherwise.
  - **Email edit** (user ruling): `PUT /v1/admin/accounts/{principal}/roles/admin/email` strict `{ revision,
    email: string | null }` on an `active` or `revoked` admin row; revision-fenced, bumps `revision`, audit
    `role_email_edit` with `detail = { role, from, to, emailChanged: true }`; an unchanged value is a 200 no-op.
  - **No email in audit, ever:** `admin_audit` is append-only and principal-only; grant, edit and request audit rows
    carry no email value (`emailChanged: true` at most).
  - **Delete:** `clearRequestEmail` becomes `clearEmails` (both columns NULL where either is set; roles, revision and
    audit unchanged); update the players.service comment, the schema.ts comment and the openapi `DELETE /v1/me` text.
  - **Contract (additive):** keep `requestEmail`; add required-nullable `grantEmail`, plus `email` and
    `emailSource: "verified_at_request" | "typed" | null` on the admin views; the openapi says a typed email is
    unverified and display-only. The queue `state` enum and its 400 message gain `blocked` (listed by original request
    time). A block is per principal: a new Firebase account can request again; blocks are never matched by email.
  - Acceptance (tests): block from each of the four states; block to block 409; unblock from non-blocked 409; block with
    no photographer row 404; block refused while the account is an active admin; grant (API and `roles:grant`)
    refused while blocked; a blocked request is 403 with `request_email`, revision and audit count unchanged, including
    when the block lands between the unlocked pre-read and the lock; concurrent block vs request (both orders) and
    block vs approve at one revision (one wins, 409); two admins racing block/unblock; a blocked photographer gets 403
    on `POST /v1/admin/media` before the body is read; unblock, request, approve end to end; `GET /v1/me/roles` shows
    `blocked`; `?state=blocked` lists only photographer rows and paginates; block/unblock/edit bodies carrying role or
    state are 400; an invalid grant email (non-string, too long, control characters) is 400; re-grant replace vs keep,
    and after `DELETE /v1/me` (stays NULL); email edit fenced, no-op, audited without the value; no email in any audit
    row; `roles:grant --email` stores it, and a bad value exits 2 with nothing written; `DELETE /v1/me` clears both
    emails; 0018 over rows seeded in every prior state, then a fresh-database migrate; live parity e2e green;
    `role_block`, `role_unblock` and `role_email_edit` audit rows have the R-b shape.
  - Files: `drizzle/0018_*` + `drizzle/meta/*` (generated), `src/db/schema.ts`, `src/db/enums.ts`,
    `test/schema-parity.ts`, `src/accounts/{role-store,accounts.controller}.ts` + the email helper,
    `src/players/players.service.ts` (comment and call rename), `scripts/roles-grant.mjs`, README, `docs/openapi.yaml`
    (role operations and schemas only), role e2e tests, `test/media-schema.e2e.test.ts` (CHECK tests). Depends on:
    R-b, R-c, T3 committed.

### Phase 1: foundation

- [x] **T0: Record the media contract as `x-planned`** — S
  - Add the staff routes (`POST /v1/admin/media`, `POST .../{mediaId}/versions`, `PATCH .../{mediaId}`,
    `POST .../publish`, `POST .../withdraw`, `GET /v1/admin/media`, `GET .../{mediaId}`,
    `PUT /v1/admin/content/{module}/items/{id}/media`), `GET /v1/media?ids=`, schemas `MediaItem`, `MediaLicence`,
    `ImageRef`, and `media_invalid` in `x-planned-enum` to `docs/openapi.yaml`, each operation `x-planned: true` with a
    note.
  - Contract details from the plan gate: 413 `invalid_request` with the route-scoped limit, the larger body read only
    after the token and role are verified; 415 for another Content-Type; required `Idempotency-Key` (trip shape, 400
    when missing); opaque `cursor` with a length cap (malformed 400), `nextCursor: string | null`, default `limit` 50;
    `ImageRef.url` and `expiresAt` both set or both null (with a `reason` enum), `expiresAt` = the signed expiry in whole
    seconds; `GET /v1/media?ids=` takes 1-50 strictly parsed ids, collapses duplicates, keeps request order, `no-store`,
    never returns owner principals; `media_invalid` documents both meanings (bad bytes, unknown media id); `MediaItem`
    exposes `revision`, `draftVersion`, `publishedVersion`.
  - Acceptance: the parity test treats every new operation as planned (each answers 404 `not_found` today); no built
    route changes; `info.version` unchanged.
  - Verify: `npm run test:e2e -- openapi` green; `npm test` green.
  - Files: `docs/openapi.yaml`, `test/openapi.e2e.test.ts` (planned path samples). Depends on: R-b (same hot files;
    lane 1, after R-b).
- [x] **T1: Pure image sniffer and CDN link signer** — S
  - `src/content/media/image-sniff.ts`: JPEG (SOI + SOFn dimensions) and PNG (signature + IHDR) only; returns type,
    width, height or a reason. `src/platform/cdn-signer.ts`: Bunny advanced token `HS256-` + base64url(HMAC-SHA256(key,
    path + expires [+ sorted signed params])), per-file path, no IP, query form `?token=&expires=`.
  - Acceptance: sniffer rejects truncated, spoofed-extension and > 4096 px images; signer matches fixed test vectors built
    from Bunny's documented algorithm (cite the doc URL in the test) and never signs a path outside
    `/backend/content/photos/`.
  - Verify: unit tests (added to the `vitest.config.ts` include list).
  - Files: the two sources, two tests, `vitest.config.ts`. Depends on: none. **Parallel with T0.**
- [x] **T2: Schema and migration 0017** — M
  - `media_items`: `id bigint GENERATED ALWAYS AS IDENTITY` (rendered `med-<n>` in the API, parsed strictly with
    `^med-[1-9][0-9]{0,14}$`, 15 digits so ids stay JS-safe integers), `owner` (uploader principal), `state` (`unverified|published|withdrawn`, TS-list parity),
    `revision` (>= 1, the optimistic fence for every write: licence, state, new version), `draft_version` (latest upload)
    and `published_version` NULL (what players and releases see; user 2026-11-03: a published image and credit stay live
    until an admin publishes the change), `created_by`/`updated_by` (1-256), timestamps from the database clock (no
    `defaultNow`). No FK from the item to its versions (circular); a service invariant with a test instead.
  - `media_versions` (media_id FK, version >= 1, UNIQUE (media_id, version)): `sha256 ~ '^[0-9a-f]{64}$'`, `content_type IN
    ('image/jpeg','image/png')`, `byte_size BETWEEN 1 AND 5242880`, `width`/`height BETWEEN 1 AND 4096`, the licence fields
    per version (so a published credit is frozen with its file): `credit_name` <= 200, `licence_name` <= 200,
    `licence_url`/`source_url` `~ '^https?://'` and <= 2048, `attribution_text` <= 1000, `credit_required` boolean;
    `blob_key` derived from sha256 and type (not stored), and a CHECK that a version may be published only with a licence
    name and, when `credit_required`, a credit name.
  - `media_upload_keys`: PK (principal, idempotency_key), key CHECK `^[A-Za-z0-9_-]{1,128}$`, `operation`
    (`create`|`version`), `media_id` NOT NULL FK, `version`, `sha256`, `created_at`. Claimed with `INSERT ... ON CONFLICT
    DO NOTHING RETURNING` after the item/version insert in the same transaction; no row = roll back and replay from the
    stored key (sha256 equal = 200 replay, else 422 `idempotency_key_reused`). `POST .../versions` also takes a required
    `Idempotency-Key`.
  - `content_items.media_id bigint NULL` FK ON DELETE NO ACTION (media is never deleted), indexed.
  - Indexes: `media_items (owner, id DESC)`, `(state, id DESC)`, `media_versions (sha256)`. Keyset cursor = opaque
    base64url of the id (never `created_at`).
  - Audit actions `media_upload`, `media_version`, `media_edit`, `media_publish`, `media_withdraw`, `content_media_link`;
    TS lists + S5 parity for every new enumerated CHECK.
  - Acceptance: generated with `npm run db:generate` (second run: no changes); `npm run contracts:write` produces no diff;
    CHECK violations tested (unpublishable licence, non-http URL, bad sha256, oversize); the same idempotency key from two
    principals gives two independent items.
  - Files: `src/db/schema.ts`, `src/db/enums.ts`, `drizzle/0017*`, `drizzle/meta/*`, `test/schema-parity*`. Depends on:
    R-a committed (0016 final). Lane 2; R-b must not touch these files.

### Checkpoint A (after T0–T2)

- [x] typecheck, unit, e2e green; independent review of T0–T2; commit per task; push.

### Phase 2: staff media

- [x] **T3: Upload a new media item** — M
  - `POST /v1/admin/media` (raw bytes through a route-scoped body reader, 5 MB, `@Roles("photographer")` (admin
    included), required
    `Idempotency-Key`). Sniff → hash → `put` `content/photos/<sha256>.<ext>` → `get` and compare the hash → one
    transaction: claim the key (unique insert), insert item + version 1 (`unverified`), audit row.
  - Acceptance: 201 `MediaItem`; same key + same bytes → 200 replay with the same item; same key + other bytes → 422
    `idempotency_key_reused`; concurrent duplicate → exactly one item; bad image → 422 `media_invalid`; > 5 MB → 413;
    storage down → 503 `storage_unavailable` and nothing written; no response contains the storage path.
  - An identical re-put is allowed (T3 review): a retry, lost race or second upload of the same bytes re-puts
    the same file under its content-addressed key; ADR-0001's "nothing is overwritten" holds for content.
  - Verify: e2e `test/media.e2e.test.ts` against `MemoryBlobStore`; the route moves from `x-planned` to built in openapi.
  - Files: `src/content/media/{media.module,media.controller,media.service}.ts`, `src/app.setup.ts`,
    `src/app.module.ts`, `docs/openapi.yaml`, `src/common/errors.ts`, the test. Depends on: T1, T2.
- [x] **T4: New version, licence edit, publish, withdraw** — M
  - `POST .../{mediaId}/versions` (required `Idempotency-Key`, `?revision=`), `PATCH .../{mediaId}` `{ revision, licence?,
    note? }` (strict; absent keeps a field, `null` clears it; edits the draft version's licence), `POST .../publish` and
    `.../withdraw` `{ revision }` (`@Roles("admin")`). **Licence edits never touch the live version** (lead, from
    the 2026-11-03 ruling): when `draftVersion == publishedVersion`, a PATCH creates a new draft version with the same
    file (sha256, type, size, dimensions), `version + 1` and the edited licence; otherwise it edits the unpublished draft
    in place — except a draft that was ever published (now withdrawn), which also gets `version + 1` (T4 build, lead
    accepted: a once-live version's licence is history, and clearing it would break the publishable CHECK). `licence` is required in a PATCH (`note` optional). **Idempotency first:** on both upload routes the
    `Idempotency-Key` lookup runs before the `revision` fence; a replay needs the same operation, `mediaId` and sha256
    (else 422 `idempotency_key_reused`) and answers 200 with the item as stored. Withdrawn items may get new versions
    and be published again. Every write is fenced by `media_items.revision` (stale → 409
    `version_conflict`, nothing changes). A photographer's new version or licence edit changes only the draft; the
    `published_version` and its credit stay live until an admin publishes (user, 2026-11-03). Publishing checks the draft's
    licence (422 `content_invalid`); publishing an unchanged published draft → 409 `nothing_to_publish`.
  - Photographers act on **their own** items only (others: 404, existence not leaked). Refusals returned, not thrown,
    inside transactions (`ExpectedRollback`). One audit row per change with a field diff; licence text verbatim (trim only;
    control characters refused).
  - Verify: e2e in the same file; openapi moves these routes to built.
  - Files: media service/controller, openapi, the test. Depends on: T3.
### Checkpoint B (after T3–T4)

- [x] green suites; independent review; commit; push.

### Phase 3: reading images

- [x] **T5: Staff list and get with a preview link** — M
  - `GET /v1/admin/media?state=&cursor=&limit=` (newest first, `limit` <= 100, opaque cursor) and
    `GET .../{mediaId}` (item, version history, preview `ImageRef` signed in any state). Photographers see only their
    own items; admins see all. Config `BUNNY_CDN_HOST` and
    `BUNNY_CDN_TOKEN_KEY` (validated; required only to sign; without them a preview has `url: null` and a documented
    reason, so local runs work).
  - Acceptance: pagination is stable under inserts; `ImageRef.expiresAt` = database now + 24 h; the URL verifies with the
    T1 signer; the key never appears in logs or responses.
  - Verify: e2e; config unit tests.
  - Files: media controller/service, `src/config/config.module.ts`, `.env.example`, tests. Depends on: T1, T4.
- [x] **T6: Link a content item to a media item** — S
  - `PUT /v1/admin/content/{module}/items/{id}/media` (`@Roles("admin")`) `{ mediaId | null, expectedVersion }` through the A1 edit service
    (module lock, version bump, `content_media_link` audit); items list and export gain a `mediaId` column (import
    ignores it).
  - Acceptance: stale version 409; unknown media 422 `media_invalid`; unknown item 404; an import never changes
    `media_id`; a client sheet still replays only when no staff write followed it (the link counts as a staff write).
  - Verify: e2e in `test/content-items-edit.e2e.test.ts`.
  - Files: `src/content/content-item-edit.service.ts`, `content.controller.ts`, `content.service.ts` (list/export),
    openapi, the test. Depends on: T2. **Parallel with T5** (disjoint files).
- [x] **T7: Website batch read** — S
  - `GET /v1/media?ids=` (signed-in caller, at most 50 ids, `published` only; others absent), `X-Client: web` accepted
    as today.
  - Acceptance: unpublished, withdrawn and unknown ids are absent (no 404); response order follows `ids`; links signed per
    file; strict query validation.
  - Verify: e2e.
  - Files: media controller/service, openapi, the test. Depends on: T5.

### Checkpoint C (after T5–T7)

- [x] green suites; independent review over T5–T7; commit; push; message the website and Unity sessions with the
  contract (ADR-0001 action item 6).

### Phase 4: documentation and live setup

- [x] **T8: Docs and config surface** — S
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

One working tree, no worktrees (user, 2026-11-03), disjoint file ownership, one test database per implementer.

- **Gate:** R-a and T1 (with review fixes) are committed and pushed before anything below starts, so 0016 is final
  before T2 generates 0017.
- **Lane 1 (sequential):** R-b, then R-c, then T0. Owns `src/accounts/*`, `src/players/players.service.ts`,
  `src/app.module.ts`, `src/common/errors.ts`, `docs/openapi.yaml`, `test/api.test.ts`, `test/openapi.e2e.test.ts`, the
  role e2e tests, `scripts/roles-grant.mjs`, `package.json`, README.
- **Lane 2:** T2. Owns `src/db/schema.ts`, `src/db/enums.ts`, `drizzle/0017*`, `drizzle/meta/*`, `test/schema-parity*`.
- **Lead only:** `vitest.config.ts` (new unit test includes) and `docs/TASKS.md`.
- Later: T3 → T4 (sequential); T5 ∥ T6 (disjoint files); T7.
- Review: one `code-reviewer` pass per checkpoint; security focus on R-b and R-c; T0 and T2 need a parity check.

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
optional); photographers upload, admins publish; roles per ADR-0002. Plan-gate rulings (user, 2026-11-03): a
published image and credit stay live until an admin publishes a change; a photographer request records the
requester's verified email for admins only (cleared by `DELETE /v1/me`); `player` is informational and not
revocable in this wave; roles and audit rows survive `DELETE /v1/me`; self-revoke is allowed while another admin
remains; `roles:grant` runs only when no active admin exists, accepts only `admin` and needs `--yes`. Plan gate
2026-11-03: `senior-lead` and `backend-expert` approved with changes, all applied above.
