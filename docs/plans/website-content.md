# Plan: website content endpoints (leaving Cloudflare D1)

Status: **approved with changes, revised 2026-11-05.** Reviews: senior-lead, backend-expert, game-domain-expert (all
"approve with changes"; every required change is folded in below). Source: website brief
`../website/docs/briefs/backend-content-gaps-for-server-hosting.md` (website `6309128`), hosting ruling
`../docs/briefs/website-admin-hosting.md`, rulings D-2 and C1 (`../docs/PROJECT_STATE.md`).

## Rulings (user, 2026-11-05, asked in this session)

- **WC-1 No per-use usage offers.** A published photo (rights v1 stated, licence set, credit when required, which is the
  DB publishable CHECK, `src/db/schema.ts:428-431`) counts as allowed for every use: games, website, Plane of the Day. The
  website's "approval plus usage offers" rule reads, on the backend, as "the photo is published". No `usage_offers` column,
  no header. The website's copy must make the rights v1 consent ("Airplane Games may publish this photo, after review",
  `docs/plans/media-rights-and-public.md:14`) cover every use; that is the website's to word.
- **WC-2 D1 desk records are recreated, not migrated.** Staff rebuild Military preparation, Aircraft Identifier and Plane
  of the Day records on the backend desks. This replaces C1 for desk records (C1 said migrate). **W2, the D1 id → media id
  read, is dropped.** The D1 photo import itself (`media:import`) is unchanged.
- **WC-3 Client photos.** The client's Unsplash-licensed Military and Aircraft Identifier photos are uploaded as backend
  media by a staff photographer account, rights `v1_authorised`, licence "Unsplash License", the client's credit. That is
  an operating step, not code.
- **WC-4 The admin audit desk stays** (user confirmed directly). W4 is in scope.

Waves: **W1** Plane of the Day public read + Aircraft Identifier / Plane of the Day desks; **W3** Military preparation, then
releases (two commits); **W4** audit read. (W2 dropped by WC-2; numbering kept so the website brief's references stay valid.)

Rules that hold for every wave:
- Each write is one transaction with version compare-and-set (`UPDATE … WHERE version = expected` repeated on the write).
  A stale version is 409 `version_conflict`.
- One `admin_audit` row per change; an unchanged request writes nothing.
- Expected refusals are returned, not thrown (`ContentItemEditService.run`, `src/content/content-item-edit.service.ts:149-195`),
  with reasons in `extra.errors: string[]` (`src/common/errors.ts:46-57`).
- Request schemas are strict. Staff routes use `@Roles("admin")` + `@SkipClientVersion()` (ADR-0002: website "staff" = backend
  `admin`; photographers never use these desks).
- Timestamps come from the database clock. Every ambiguity becomes an `ASSUMPTION:` test.
- The backend validates and stores only what staff or photographers enter. It never generates or prefills any question,
  answer, hint or fact.

## 0. Findings that shape the plan

1. **"Approved photo" = published media**: `media_items.state = 'published'` with its `published_version` (WC-1).
2. **Demo content** cannot reach a desk by construction: the demo principal never holds photographer or admin
   (`src/accounts/account-principal.ts:32-39`) and the D1 import refuses it as owner (`media-import.ts:399`). Publishing still
   refuses demo-owned media (defence in depth, ASSUMPTION test).
3. **The client has delivered Aircraft Identifier and Plane of the Day content.** The 2026-09-28 delivery in Unity
   `docs/client-content/2026-09-28/` holds `Airplane Identifier v1.xlsx` (31 questions imported in Unity, `ai-a8`/`ai-a14` left
   out), an Identifier photo zip and a Plane of the Day zip (5 entries), per Unity `docs/implementation/CLIENT_CONTENT_IMPORT.md:3-10`.
   ⚠️ `../docs/content-sources.md:15` ("Needed" is the Photos column) and PROJECT_STATE §5 don't list this delivery; a message
   goes to the design-docs session to add it. Consequences here:
   - **Desk question fields are never dealable.** The Identifier desk's `correctAnswer`, `distractors`, `difficulty` are
     editorial (website parity) and never feed the dealer, the content manifest or a release. The only source of dealable
     `identifier` questions is the client sheet via 5.Q slice I3. Source-scan ASSUMPTION test: no file under `src/rounds`,
     `src/rules`, `src/content/documents` or `src/content/releases` reads `editorial_items`.
   - **The 5 client Plane of the Day entries are not seeded** into the desk (that would be a prefill); staff create them.
4. **Identifier does not fit `ContentModuleMapping`**: the interface is sheet-centred (`src/content/content-module.ts:47-65`),
   a client-sheet import retires rows the file doesn't list (`:14-17`), `ItemStatus` is `approved | retired` (`:35`), and the
   desk payload is editorial. So both desks get their own table `editorial_items`; `content_items`, `ItemStatus` and
   `MAPPINGS` (`src/content/content-modules.ts:6-8`) are unchanged.
5. **Plane of the Day is not a Module.** `MODULE_IDS` stays at 8 (`src/rules/modules.ts:6-15`). It is the concept deck's Daily
   Experience, stored as `editorial_items.kind = 'plane-of-the-day'`. The kind list is its own literal, never derived from
   `MODULE_IDS`/`MODULE_LIST` (unit test).
6. **Several Plane of the Day items per date are allowed** (website parity). The concept says "featured photos rotate across
   user regions" (`../docs/aviation-arcade-v1.md:35`), so no one-per-day index. The public read returns every due feature,
   newest first. Regional rotation is a client question (sent to Unity for `CLIENT_CONTENT_IMPORT.md`).
7. **Military photo link** is the existing `content_items.media_id`, set by `PUT .../items/:id/media`, which links media in any
   state (`content-item-edit.service.ts:121-147`). W3 makes preparation and that route share one link and adds a guard at
   stage ≥ `rights_checked` (behaviour change for Military only, ASSUMPTION test).
8. **Releases (5.Q) assume Bunny snapshots** (`docs/design/releases-and-dealing.md` §3). W3 builds the Postgres rows only; see
   §3.7 for the deviations and the rule that R3 must not honour pre-delivery activations.
9. **C13 coverage.** The backend Military dealer is `nearest-ranks` (`src/rules/dealer.ts:43-46`, matches Unity
   `BuildMilitaryDeck`); the website's rule is the commercial `lower-ranks` one ("own rank up to 6, then lower ranks"). W3 gates
   on the backend dealer and also reports own-rank counts so the desk still shows a shortage. ASSUMPTION test
   `ASSUMPTION: Military release coverage uses nearest-ranks (C13 open)`.
10. **Doc fixes.** `docs/ARCHITECTURE.md:227-229` and `:232-233` wrongly say edit-in-place isn't built (it is, TASKS 5.M,
    `content.controller.ts:154-199`): fixed in W1. `:100` lists public routes (add the new one, W1). `:182` ("no release yet")
    in W3. ADR-0001 decision 4 says a Plane of the Day entry publishes the image; here the media must already be published:
    amended in W1, with §8 noting a second guest route.

---

## W1: Plane of the Day public read + Identifier / Plane of the Day desks (API 0.23.0, migration 0022)

### 1.1 Migration `0022_editorial_items` (generated; a second `db:generate` reports no changes)

**`editorial_items`**

| column | type / rule |
|---|---|
| `id` | bigint identity PK, wire `ed-<n>` |
| `kind` | text CHECK IN (`identifier`, `plane-of-the-day`) |
| `media_id` | bigint NOT NULL FK `media_items` (no ON DELETE); fixed at create |
| `status` | text CHECK IN (`draft`, `scheduled`, `published`, `archived`) |
| `date_key` | `date("date_key", { mode: "string" })` NULL (as `src/db/schema.ts:110`) |
| `data` | jsonb NOT NULL (shape §1.3) |
| `version` | int NOT NULL DEFAULT 1, CHECK ≥ 1 |
| `created_at`, `updated_at` | timestamptz, database clock |
| `created_by`, `updated_by` | text principal, length 1-256 |

Rule CHECKs (registered in `RULE_CHECKS`, `test/schema-parity.ts:82-91`, since the `NOT IN` form is picked up by the schema
extractor):
- `kind <> 'identifier' OR (date_key IS NULL AND status <> 'scheduled')`
- `kind <> 'plane-of-the-day' OR status NOT IN ('scheduled','published') OR date_key IS NOT NULL`

Enum lists registered in `EXPECTED_ENUM_CHECKS`: `EDITORIAL_KINDS`, `EDITORIAL_STATUSES` (`src/db/enums.ts`).
Indexes: `(kind, date_key DESC) WHERE status IN ('scheduled','published')`, `(kind, updated_at DESC)`, `(media_id)`.
**Audit actions** `editorial_create`, `editorial_save` (target `<kind>`) added to `admin_audit_action_check`
(`schema.ts:533-556`), `ADMIN_AUDIT_ACTIONS` and the parity list.

### 1.2 Routes

| Method, path | Role | Request | Responses |
|---|---|---|---|
| `GET /v1/admin/editorial/{kind}/items` | admin | no query | 200 `{ items: EditorialItem[] }`, newest `updated_at` first, at most 200 (ASSUMPTION). Unknown kind → 404 |
| `POST /v1/admin/editorial/{kind}/items` | admin | `{ mediaId: "med-<n>", data?: EditorialData }` strict | 201 `{ item }`. 422 `content_invalid` (no such media, media not published, demo-owned, bad shape) with `errors[]`. 404 kind |
| `PUT /v1/admin/editorial/{kind}/items/{id}` | admin | `{ version, status, data, dateKey?: "YYYY-MM-DD" \| null }` strict | 200 `{ changed, item }`. 404 (unknown or other-kind id). 409 `version_conflict`. 422 `content_invalid` with `errors[]` |
| `GET /v1/public/plane-of-the-day` | `@Public()`, `@SkipClientVersion()`, public rate tier | `?timeZone=<IANA>` optional (default `UTC`), strict query | 200 `{ day: "YYYY-MM-DD", features: PublicFeature[] }`. 400 `invalid_request` for a bad zone or extra key |

- `EditorialItem` = `{ id, kind, mediaId, status, dateKey|null, version, data, createdAt, updatedAt }`; no principal.
- `PublicFeature` = `{ id, date, title, aircraft, photographer, instagram, description, image: ImageRef }`. `ImageRef` is the
  guest-media shape (`src/content/media/image-ref.ts:12-20`); **the public credit is `image.licence.credit`**, the credit frozen
  on the published media version. Staff-typed `data.credit` is never public (one attribution only).
- **Never public:** credit (staff-typed), correctAnswer, distractors, difficulty, factualSource, status, version, media owner,
  media description, rights.
- The website's `/api/photos/:id` = find the id in `features`, use `image.url`; no by-id backend route.
- Not folded into the content manifest: the manifest is signed-in and document-versioned
  (`src/content/documents/content-documents.controller.ts:18-36`); a daily feature changes daily and guests read it.
- The public tier limits per IP and the website server is one IP for every guest, so the website caches the response on its
  server (refreshing ahead of the image `expiresAt`), never per visitor. Said in the contract and the reply.

### 1.3 Service rules (`src/content/editorial/editorial.service.ts`)

**`data` shape** (every create and save), strict:
`{ title, aircraft, photographer, instagram, credit, description, correctAnswer, distractors: [s,s,s], difficulty, factualSource }`.
- Every string ≤ 2400 code points; `distractors` exactly 3 strings; CRLF→LF; no control character other than `\n`. Text trimmed
  on store (ASSUMPTION test).
- `instagram` optional-in-meaning (may be `""`): when set, a handle `@?[A-Za-z0-9._]{1,30}` or an `https://` URL (concept deck
  `aviation-arcade-v1.md:33-34`, client feedback CF-10/CON-01). Staff-entered; whether photographers supply handles is a client
  question.
- `difficulty` is `""` or the item's Rank (backend rank id, `src/rules/ranks.ts:6`); the website maps display names.
- **No `imageUrl`**: the image is always the linked media's published version, so a sent `imageUrl` is an unknown key (400).
- A create without `data` stores the blank shape. Nothing is prefilled from media.

**Create** (`kind`, `mediaId` fixed for life), one transaction: media `FOR SHARE`; must exist, be `published`, owner ≠ demo
principal. Insert `draft` v1; audit `editorial_create` target `<kind>`, detail `{ id, mediaId }`.

**Save**, one transaction:
1. Lock the item `FOR UPDATE`; a different kind → 404. Version mismatch → 409 `version_conflict`.
2. `dateKey`: absent/null for `identifier`; a real calendar date or null for Plane of the Day (port of
   `website/lib/rules.ts:115-121` `validDate`).
3. For `status ∈ {scheduled, published}`, collect **all** errors (port of `website/lib/rules.ts:164-186` `editorialErrors` plus
   the content-d1 save checks):
   - title trimmed ≥ 3; factualSource starts with `https://`;
   - Identifier: correctAnswer + 3 distractors non-blank and distinct (case-insensitive, trimmed); difficulty a rank id;
     `scheduled` → "Aircraft Identifier supports draft or published content, not daily scheduling.";
   - Plane of the Day: description trimmed ≥ 15; dateKey required;
   - media (`FOR SHARE`): `published`, owner ≠ demo, and the published version's licence credit non-blank.
4. `draft`/`archived` saves need only the shape. Any status may move to any other (website parity).
5. Unchanged (status, dateKey, canonical data) → `changed: false`, no audit row. Otherwise bump version, set `updated_*`;
   audit `editorial_save` detail `{ id, fromVersion, version, fromStatus, status, fromDateKey, dateKey, fields }` (no text bodies).

**Withdrawn media / new published version:** nothing is rewritten; the public read and later saves re-check, so a withdrawn
photo drops out at once. A newly published media version is followed, not pinned (ASSUMPTION test).

### 1.4 Public read: the viewer's day

**ASSUMPTION: the server takes an IANA `timeZone` and computes the day itself** (the website already sends one,
`website/lib/request/routes.ts:190-198`; no client clock trusted).
1. Validate: 1-64 characters of `[A-Za-z0-9_/\-]` with a letter first (so no leading `+`/`-`), `new Intl.DateTimeFormat("en-US",
   { timeZone })` must not throw, and `resolvedOptions().timeZone` must not start with `+` or `-`. Offset zones (`+2359`,
   `+23:59`, `+14`) are 400: Node 24 accepts them and `+23:59` would show tomorrow's UTC feature from 00:01 UTC.
2. Read `databaseNow` once (`src/database/clock.ts:35`); compute `day` with `formatToParts` (year/month/day parts, not the
   locale's output format).
3. Independent bound: `day` must be ≤ the date of `databaseNow` in `Etc/GMT-14` (UTC+14, the furthest real zone); else clamp.
   So the worst case is tomorrow's UTC feature visible from 10:00 UTC (as via `Pacific/Kiritimati`), never earlier and never
   the day after. ASSUMPTION test "a UTC+14 viewer sees the next UTC date's feature, never the one after".
4. Return Plane of the Day items with `status IN ('scheduled','published') AND date_key <= day`, media `published`, owner ≠ demo,
   licence credit non-blank. Order `date_key DESC, updated_at DESC, id DESC`, limit 100 (pagination deferred).

Rate tier as `GET /v1/public/media` (`media-guest.controller.ts:14-24`).

### 1.5 Tests

- **Unit `test/editorial-rules.test.ts`:** shape and caps; exactly 3 distractors (2 and 4 refused); distinct case-folding; https
  factualSource; instagram handle/URL; rank ids; description ≥ 15; `validDate` (2026-02-29 refused); all errors at once; the
  kind list is a literal not derived from `MODULE_IDS`.
- **Unit `test/local-day.test.ts`:** zone validation (`+2359`, `+23:59`, `+14`, `-05`, `Etc/../x`, 65 chars → refused;
  `Pacific/Kiritimati`, `America/New_York`, `UTC` → accepted); day at the boundaries; the UTC+14 clamp.
- **e2e `test/editorial.e2e.test.ts`:** create from published media → 201 + one audit row; unpublished / withdrawn media → 422;
  photographer 403, no token 401; stale version 409 with nothing written; unchanged save no audit row; publish refusals list
  every reason; identifier scheduled → 422; two Plane of the Day items on one date both publish; `imageUrl` → 400; a media
  withdraw racing a publish is serialised.
- **e2e `test/potd-public.e2e.test.ts`:** no token 200, garbage token ignored; only due + scheduled/published + published media
  + licence credit; deep scan finds no `owner`, `createdBy`, `rights`, `correctAnswer`, `distractors`, `factualSource`,
  `difficulty`, `status`, `version`, and no `credit` outside `image.licence`; newest first; withdrawn media disappears; bad zone
  400; 429 on the public tier; clock-offset seam (`clock.ts:40`) for midnight in two zones.
- **ASSUMPTION tests:** the feature follows the media's current published version; demo-owned media refused at publish; list at
  most 200; UTC+14 sees the next UTC date only; text trimmed on store; editorial items never read by dealer/manifest/release
  code (source scan); several Plane of the Day items per date allowed.
- `test/api.test.ts:684-689`: 61 → 65 routes, and the new public route expects 200 with no token (not 401). Openapi parity test.

### 1.6 Contract and docs

`docs/openapi.yaml` 0.22.1 → **0.23.0**, changelog block: editorial routes, the public read and its date rule, the public credit
being `image.licence.credit`, "no imageUrl", `difficulty` = the item's Rank (backend rank id), "website caches server-side",
WC-1 ("published = allowed for every use"). `npm run contracts:write` shows no diff. ARCHITECTURE: §0.10 fixes and a new
"Editorial desks and Plane of the Day" section. ADR-0001 amendment (decision 4, §8). TASKS row.

### 1.7 File ownership (sequential where they touch)

- **W1-0 (integrator, first):** `src/db/schema.ts`, `src/db/enums.ts`, `drizzle/0022_*` + meta, `test/schema-parity.ts`; fixes the
  `editorial-view.ts` public-query export signature.
- **W1-B desks:** new `src/content/editorial/{editorial.service.ts, editorial-rules.ts, editorial-view.ts,
  editorial-admin.controller.ts, editorial.module.ts}`, `test/editorial-rules.test.ts`, `test/editorial.e2e.test.ts`.
- **W1-C public read (after W1-B):** new `src/content/editorial/{editorial-public.controller.ts, local-day.ts}`,
  `test/local-day.test.ts`, `test/potd-public.e2e.test.ts`.
- **Integrator, last:** register W1-C in `editorial.module.ts`, `src/app.module.ts`, `docs/openapi.yaml`, `test/api.test.ts`, docs.

---

## W2: dropped (WC-2)

---

## W3: Military preparation (commit 1) + releases (commit 2) (API 0.24.0, migration 0023)

### 3.1 Migration `0023_military_preparation_and_releases`

**`content_items` gains `prep_stage text NULL`, `prep_evidence jsonb NULL`, `prep_version int NULL`**: all null or all set
(`RULE_CHECKS`); `prep_stage IN ('missing_photo','rights_checked','content_prepared','previewed','approved')`
(`website/lib/military.ts:74-80`). `prep_version` is the item version the preparation save produced: any later import, edit,
relink, retire or restore bumps the item version past it, so the stage is **stale** ("prepare again") and upload refuses it.
ASSUMPTION test `ASSUMPTION: a sheet re-import that changes an item makes its preparation stale`. ⚠️ The website's "version 0 =
never saved" becomes `preparation: null`.

**`content_releases`** (insert-only trigger, by hand as in `0011`): `module`, `version` (PK `module, version`), `basis` text
(≤ 65536), `item_count` 1..2000, `deal_rule` (`nearest-ranks`), `flight_kind` (`choice`), `created_at`, `created_by`, `note` ≤ 500.

**`content_release_items`** (insert-only): `module`, `release_version`, `item_id`, `item_version`, `position`, `rank`, `card_key`,
`media_id`, `media_version`, `photo_sha256`, `credit` NULL, `deal` jsonb `{ answer, wrong }`; PK (`module, release_version,
item_id`); UNIQUE (`module, release_version, position`); composite FKs `(module, release_version) → content_releases(module,
version)` and `(media_id, media_version) → media_versions`.

**`content_release_activations`** (append-only): `id` identity, `module`, `sequence` int ≥ 1 UNIQUE per module, `kind` IN
(`activate`, `restore`), `release_version` (composite FK, NOT NULL), `history int[]`, `created_at`, `created_by`, `note`.
**Pointer** = newest row `{ current, history, version: sequence }`, or `{ current: null, history: [], version: 0 }`.

Enum lists: prep stages, activation kinds, `deal_rule`, `flight_kind`, the four audit actions `content_prepare`,
`release_create`, `release_activate`, `release_restore`. Single writer: `src/content/releases/release-store.ts` (source-scan test).

### 3.2 Routes (module `aircraft-identifier-military` only; any other → 404)

| Method, path | Request | Responses |
|---|---|---|
| `GET /v1/admin/content/{module}/items` (existing) | — | Items gain `preparation: { stage, evidence, stale } \| null` (additive; null for other modules) |
| `PUT /v1/admin/content/{module}/items/{id}/preparation` | `{ version, stage, evidence, mediaId: "med-<n>" \| null }` strict | 200 `{ changed, item }`; 404; 409 `version_conflict` / `import_in_progress`; 422 `content_invalid` with `errors[]` |
| `PUT /v1/admin/content/{module}/items/{id}/media` (existing) | unchanged | New for Military: at `prep_stage ≥ rights_checked` the media guard applies → 422 |
| `GET /v1/admin/content/{module}/releases` | — | 200 `{ pointer, releases: ReleaseSummary[] (newest 50), ownRankCounts }`. `ownRankCounts` per rank, non-blocking (C13) |
| `POST /v1/admin/content/{module}/releases` | `{ itemIds: string[1..2000], basis, previewed: true, note? }` strict | 201 `ReleaseSummary` (`uploaded`); 409 `version_conflict` (basis stale); 409 `nothing_to_publish` (same basis as current, `errors.ts:35`); 409 `release_in_progress`; 422 with `errors[]` |
| `POST /v1/admin/content/{module}/releases/{version}/activate` | `{ expectedPointerVersion, note? }` | 200 `{ pointer, releases }`; 404; 409 `version_conflict` (pointer stale, or candidate changed, with `errors[]`); 409 `nothing_to_publish`; 409 `release_in_progress`; 422 already released |
| `POST /v1/admin/content/{module}/releases/restore` | `{ expectedPointerVersion, note? }` | 200 `{ pointer, releases }`; 409; 422 (no earlier release; restored photos no longer published) |

- **`itemIds` per R-3** ("staff choose the items of a release", `releases-and-dealing.md:15, 167`): the website can send every id
  to keep its batch behaviour; leaving `mil-a5` (no photo) out is a choice, not a retire.
- `basis` = the sorted `"<id>:<version>"` of the chosen items joined by `,` (port of `releaseBasis` over the selection).
- `evidence` = strict `{ photoSource: "" | "media" | "licensed", licenseUrl ≤600, permission ≤2400, attribution ≤160, referenceUrl
  ≤600, checklist: { identity, answers, crop, clipperCard }, notes ≤2400 }` (`website/lib/military.ts:103-122`, 218-265).
- **Not accepted:** `answer`, `distractors`, `aliases`, `hint`, `reveal` (the question comes from the client sheet; no staff hints).
- `ReleaseSummary` = `{ number, basis, aircraft, createdAt, note, status: "uploaded" | "released" }`; route descriptions say
  "recorded, not delivered".

### 3.3 Service rules

**Preparation save** (pure rules `src/content/preparation/military-preparation.ts` + a `ContentItemEditService` method on the same
`run()` under `lockContentModule`, `content-lock.ts:12-19`; port of `website/lib/military.ts:168-216`, `store.ts` `planDraft` /
`draftPhotoGuard`):
- Retired item → 422 (ASSUMPTION). Forward one stage at a time, back to any earlier one. `approved` → `approved` with different
  evidence or mediaId → 422 "Step an approved package back to Previewed before changing it."
- Cumulative rules: ≥ 1 `media` needs `mediaId`, `licensed` needs an https `licenseUrl` (evidence only), `""` refused, permission
  ≥ 10 trimmed, attribution ≥ 2; ≥ 2 `referenceUrl` https host; ≥ 3 `checklist.crop`; ≥ 4 every checklist item.
- **Media guard** when `mediaId` is set and `to ≥ rights_checked`: `FOR SHARE`; `published`; owner ≠ demo. Else 422 "The linked
  photo must be a published photo."
- One write sets `prep_*`, `media_id`, version +1, `prep_version` = the new version. Audit `content_prepare`
  `{ id, fromVersion, version, fromStage, stage, media: {from,to} | null, fields }`. Unchanged → no row.

**Upload** (release try-lock `content-release:<module>`, busy → 409 `release_in_progress`; then `lockContentModule`, busy → 409
`import_in_progress`):
- `itemIds` distinct, all exist in the module and non-retired, else 422. `basis` ≠ server basis over them → 409
  `version_conflict` "Packages changed since this preview…". `previewed !== true` → 422. Basis equal to the current release's →
  409 `nothing_to_publish`.
- Collected errors → 422: every chosen item `approved` and **not stale** (`version = prep_version`); every chosen item has a
  `mediaId` (whatever `photoSource`, WC-3) whose media is published and not demo-owned (`FOR SHARE … ORDER BY id`); no two share a
  `photo_sha256`; coverage computed **inside the transaction** with the pure `tripCoverage(module, pool)` from
  `src/rules/dealer.ts` plus `rowToDealItem` over the rows already read (no second pooled connection), every rank dealable ≥
  flights per Trip.
- Insert release version = max + 1 plus items. A missing `card_key` is frozen into the **release row only** (the item is not
  rewritten, so no version bump invalidates the basis). Audit `release_create` `{ release, itemCount, basis }`.

**Activate** (same locks). `sequence ≠ expectedPointerVersion` → 409. At commit, under both locks, every linked media row
`FOR SHARE … ORDER BY id`:
- (a) every release item still exists and is non-retired;
- (b) for every release item, `content_items.version = item_version`;
- (c) for every release item, `media_items.state = 'published'`, `published_version = media_version`, and
  `media_versions(media_id, media_version).sha256 = photo_sha256`. The media `revision` is not compared (a draft-only edit
  leaves the published file and credit untouched; ASSUMPTION test).

Otherwise 409 `version_conflict` with `errors[]` naming each change; nothing written. Already released → 422 "Only an uploaded
release can be made live. Restore steps back to earlier ones."; same basis as current → 409 `nothing_to_publish`. Write an
`activate` row, `sequence + 1`, `history = current === null ? history : [...history, current]` (UNIQUE sequence = race backstop).
Audit `release_activate` `{ release, previous, itemCount, sequence }`.

**Restore** (release lock; media `FOR SHARE … ORDER BY id`). Stale → 409. Empty history → 422. The restored release's media must
still be published at their stored versions, else 422 with `errors[]` (ASSUMPTION). Row `restore`, `release_version =
history.pop()`. Audit `release_restore` `{ release, replaced, sequence }`.

### 3.4 Tests

- **Unit** `test/military-preparation.test.ts` (every `stageErrors` / `transitionError` case, approved-edit lock, strict evidence),
  `test/release-rules.test.ts` (basis over a selection, pointer stack, error lists).
- **e2e** `test/military-preparation.e2e.test.ts`: CAS + audit; media guard; `PUT …/media` guarded at stage ≥1 only; concurrent
  import → `import_in_progress`; a sheet re-import that changes an item marks it stale.
- **e2e** `test/military-releases.e2e.test.ts`: upload a selection → `uploaded`, not live; activate → pointer v1; restore pops;
  each guard leg → 409 with a reason; stale preparation refused; `licensed` without media refused; draft-only media edit does not
  block; stale pointer 409; two concurrent activations → one wins, the other `release_in_progress` or `version_conflict`; triggers
  refuse UPDATE/DELETE on all three tables; photographer 403.
- **ASSUMPTION tests:** coverage uses nearest-ranks (C13 open); media revision not in the guard; restore refuses unpublished
  photos; preparation on a retired item refused; same-as-current basis refused, same-as-older allowed; re-import makes preparation
  stale.

### 3.5 Contract / docs

0.24.0 changelog block. ARCHITECTURE "Admin content store": preparation + releases "recorded, not delivered" (fixes `:182`).
`releases-and-dealing.md` dated note (§3.7). TASKS rows. Route count +4.

### 3.6 Ownership

- **W3-0 integrator:** schema, enums, `drizzle/0023_*` (triggers by hand), parity.
- **W3-A preparation (commit 1):** `src/content/preparation/*`, `content-item-edit.service.ts`, `content.controller.ts`,
  `content.service.ts` (`listItems` view), its tests.
- **W3-B releases (commit 2):** new `src/content/releases/{release-store.ts, release-rules.ts, releases.controller.ts}`, its tests.
- **Integrator:** module wiring, openapi, route count, docs.

### 3.7 Deviations from 5.Q and what R3 inherits

- Activations are `kind`/`history`/`sequence` rows, not `previous_version` with NULL meaning deactivated; restore is a stack pop,
  not "activate an older version"; deactivate is deferred.
- `content_releases` is insert-only, so R3 adds snapshot/package data in an insert-only side table
  `content_release_snapshots (module, version)`, not columns on the release row.
- **R3 must not honour activations recorded before delivery is enabled.** Turning delivery on needs a fresh activation after user
  sign-off; activations made while testing the desk never start dealing. Written into `releases-and-dealing.md` and ARCHITECTURE.
- Deferred to 5.Q: Bunny snapshot/package files, `contentVersion`, `GET /v1/content/releases/...`, manifest `v: 2`, deactivate,
  republish, `dryRun`, dealt Trips and answer checks (R4), other modules' adapters. **A Military release reaches no player.**

---

## W4: Admin audit read (API 0.25.0, no migration; WC-4)

**Route:** `GET /v1/admin/audit` in `src/admin/admin.controller.ts` (`@Roles("admin")`, lines 7-15) + new `src/admin/audit-read.ts`.
No query parameters (any key → 400). 200 `{ events: [{ id, entity, action, actor, detail, createdAt }] }`, newest 50 by `id DESC`;
`entity` = `admin_audit.target`.

- **Admin only**: rows describe other people's role decisions, principals and rights evidence.
- **Actor** = the stored actor string (`firebase:<project>:<uid>`, `operator:<os user>`, `system:signup`); never an email or a name
  (`schema.ts:533`; `role-store.ts:28`). The website may map principals to names.
- **Detail** passed through, except `media_import.detail.rightsEvidence` → `rightsEvidenceLength: <n>` (photographer free text that
  may hold contact details). Free text staff typed (`note`, `changes.description`, `changes.credit`, `diff`, `fileName`) passes
  through to admins; said in the contract.
- **Leak test:** an e2e test seeds at least one row per `ADMIN_AUDIT_ACTIONS` entry (asserting coverage of the list), reads the desk
  and deep-scans the keys against `/email|token|secret|password/i` with an explicit allow-list (`emailChanged`); the projection is
  pinned to `media_import`. ASSUMPTION test "rightsEvidence is not shown on the audit desk".
- Tests: 401 / 403 (photographer) / 200; newest first; exactly 50 of 60; extra query key 400. **Not built:** paging, filters,
  actor names.

---

## Sequencing and verification

- W1 → W3 (preparation, then releases) → W4, each a focused commit and push; W4 is independent and small.
- Per wave: `npm run typecheck`, `npm test`, fresh test database `db:migrate`, `npm run test:e2e`, `db:generate` reports no changes,
  `npm run contracts:write` with no diff, `npm run build`. Record in `docs/TASKS.md` with what was not verified (no real Bunny,
  emulator tokens only).
- After each wave, reply to the website with the openapi version.

## Messages to send

- **Design-docs session:** add the 2026-09-28 Identifier + Plane of the Day delivery to `content-sources.md` and PROJECT_STATE §5;
  record WC-1…WC-4 (WC-2 replaces C1 for desk records).
- **Unity session (client questions for `CLIENT_CONTENT_IMPORT.md`):** Plane of the Day one per day worldwide or rotating by region;
  will photographers supply Instagram handles; Identifier Check Airman "6 highly similar options" (`aviation-arcade-v1.md:188`) vs
  4 answers in the sheet and Unity; until C13 is answered staff leave `mil-a5` out of Military releases.
- **Website:** WC-1 wording for the rights consent; WC-2 (no D1 desk migration, no id map); public read caching.
