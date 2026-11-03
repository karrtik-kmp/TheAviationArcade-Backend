# Content releases, server dealing and answer checks (design, revised 2026-11-03)

Status: **designed, not built.** Applies the user's rulings of 2026-11-03 (§R). Follows T6 in the agreed order and assumes
wave A has landed: A1–A4 (migrations 0014 `rate_limit_hits`, 0015 content-item audit actions; a database clock per
transaction) and the importer I1 (Airport Spotter). I2 (Runway Identifier) is parked on user rulings (§5). This wave's
migrations start at **0016**. Nothing here contacts the real Bunny zone: everything is built and tested against
`MemoryBlobStore` until the user signs off (§1.6).

## R. Rulings (user, 2026-11-03)

| # | Ruling | Effect here |
|---|---|---|
| R-1 | Reveal **one Flight at a time** on `POST /v1/rounds`, with its correct answer (consistency checks, not anti-cheat). **Every module uses the backend once its content is transferred.** | §4 is generic over all eight modules; §5 plans each |
| R-2 | Release packages and images go to **Bunny** (private zone, prefix `backend/`), not Postgres blobs. Postgres keeps metadata and what dealing integrity needs. Real Bunny only with explicit sign-off. Players get images through a backend-controlled route. Staff photo upload is in scope now. | §1, §2 |
| R-3 | Military goes straight to **required** (no app build is deployed; all local). A rollback does **not** cancel open Trips. Staff **choose the items** of a release. | §3, §4.5; `additive` dropped |
| R-4 | **Admin restore** of retired items is allowed (amends the 2026-10-28 ruling). | Releases freeze item versions, so a restore affects only later releases |
| R-5 | Importers for Airport Spotter and Runway Identifier, with Unity's corrections applied. | §5 |

## 0. Scope and limits

- **Consistency checks, not anti-cheat.** The server guarantees the reported answer is possible for the Flight it
  dealt, that the Card is the one dealt, and derives errors/attempts/finished. A modified client still sees each Flight's
  answer (R-1). `timeRemainingFraction` and `answerMs` stay client-reported within server elapsed + 2 s
  (`src/rules/flight-facts.ts`); the server has no per-module timers (Josh question).
- "Closes the trust gap" (Unity ADR-0008 §3 and S8; TASKS 5.2+) overstates this; reword to the limits above.
- **Generic machinery.** A module joins by adding (1) a content mapping (`src/content/content-modules.ts`), (2) a release
  adapter with a deal function, (3) a result schema with an answer check, (4) golden fixtures. Three Flight kinds:
  `choice`, `matching`, `grid` (§4.1).

## 1. Storage on Bunny

### 1.1 What lives where

| Thing | Bunny object (relative key; the store adds `backend/`) | Postgres |
|---|---|---|
| Release snapshot (answers; staff and CI only) | `releases/<module>/snapshot-<sha256>.json` | `content_releases.snapshot_key/sha256/byte_size` |
| Redacted player package | `releases/<module>/package-<sha256>.json` | `content_releases.package_key/sha256/byte_size` |
| Photo | `content/photos/<sha256>.<jpg\|png>` | `content_photos` row (§2.1) |
| Deal-relevant item fields | — | `content_release_items` rows (§3.1) |

Keys are content-addressed (pass `validateBlobKey`). A key's bytes never change; no code path deletes a release or photo
object (source-scan test: only `src/content/releases/release-store.ts` and `src/content/photos/photo-store.ts` `put` under
these prefixes; nothing `delete`s them). Bunny does not enforce immutability; the read-time digest check covers it.

### 1.2 Integrity: dealing reads Postgres, never Bunny

Option A (deal from the Bunny snapshot) needs Bunny at Trip open on a cold cache (503 at open), a pre-fetch outside the
player lock, and loses every release on restart with the memory store. **Option B (chosen): deal from
`content_release_items` rows.** R-2 allows Postgres to keep what dealing integrity needs; gameplay never waits on file
storage; "no network call inside the player lock" holds; the rows are typed and immutable (trigger refuses UPDATE/DELETE).

The snapshot bytes are the canonical rendering (`canonical.ts`) of the release header plus those rows, so: on first load
per process, re-render from the rows and compare with `snapshot_sha256` (mismatch → the module refuses to deal, 500
`internal_error` + error log); parsed pools memoised per (module, version, sha256), like `documentInForce`. At create:
put, read back, compare sha256 before committing; every Bunny read is re-hashed before it is served.

### 1.3 Caching

Parsed pools memoised per digest. Package and photo bytes: in-process LRU keyed by sha256, bounded by total bytes (64 MB),
filled only after verification. HTTP: strong ETag = sha256, `private, max-age=31536000, immutable`, 304.

### 1.4 Failure modes

| When | Bunny | Result |
|---|---|---|
| Release create (put snapshot + package, read back) | unavailable / 5xx / 429 / timeout | 503 `storage_unavailable` + `Retry-After: 5`; nothing in Postgres (the `storeImportBlob` pattern) |
| Release create | refuses (credentials) | 503 `storage_unavailable`, no Retry-After; status-only error log |
| Release create | read-back digest differs | 503; error log; nothing committed |
| Release create | Postgres commit fails after puts | orphans harmless (content-addressed); a retry reuses them |
| Activate / deactivate | any | no Bunny call |
| Trip open, Round issue, Round result | any | **no Bunny call**, never 503 for storage |
| Package or photo GET, cache miss | unavailable | 503 `storage_unavailable` + `Retry-After: 5` |
| Package or photo GET | object missing or digest mismatch | 503, no Retry-After; error log. Package: staff `republish` re-renders from rows. Photo: re-upload the same bytes (idempotent) |
| Photo upload | unavailable / refuses | as at release create; no row written |
| `BLOB_STORE=none` (production default) | — | create, upload, serve → 503; dealing still works |

### 1.5 Local development

`BLOB_STORE=memory` is the default outside production (refused in production). After a restart packages and photos are
gone but releases still deal; staff `republish` packages and re-upload photos.

### 1.6 Sign-off gate before real Bunny

1. The user signs off by name on the zone (`aviation-arcade-website`, `de`, prefix `backend/`).
2. `npm run bunny:check` passes against it (put, get with byte compare, delete under `setup-checks/`).
3. Only then `BLOB_STORE=bunny`, the pull zone with token auth and its Edge Rules, `BUNNY_CDN_TOKEN_KEY` and `BUNNY_CDN_HOST` (§2.3, ADR-0001).

The pull zone, token key and Edge Rules (ADR-0001) are created only with that sign-off. Tests use `MemoryBlobStore` or
`BunnyBlobStore` with a stubbed fetcher.

## 2. Photos (in scope now)

> **Status 2026-11-03.** Superseded in shape by [Backend ADR-0001](../adr/ADR-0001-image-storage-and-delivery.md) and
> [the media plan](../plans/media-pipeline.md): the built storage is `media_items` / `media_versions` (migration 0017, not the
> `content_photos` table below), the routes are `/v1/admin/media*`, `PUT /v1/admin/content/{module}/items/{id}/media` and
> `GET /v1/media` (API 0.16.0), and delivery is the token-signed Bunny pull zone of §2.3. See
> [ARCHITECTURE "Game images"](../ARCHITECTURE.md#game-images-media-pipeline-adr-0001-plan-media-pipeline). The text below
> is the earlier design, kept for the record. **Still open for Wave B:** `ImageRef` on dealt Trips and Rounds (T9 / R4),
> releases that freeze the media versions they use (R2), the live pull zone and Edge Rules (T10, needs sign-off), and Plane of the Day. Migrations 0016 (roles), 0017 (media) and 0018 are taken, so the migration numbers named below shift: releases come after 0018.

### 2.1 Tables (migration 0016)

`content_photos` (insert-only, trigger refuses UPDATE/DELETE): `sha256` text PK (`^[0-9a-f]{64}$`), `content_type`
(`image/jpeg` | `image/png`), `byte_size` 1..5,242,880, `width`/`height` 1..4096, `blob_key`, `created_at` (database
clock), `created_by`. `content_items.photo_sha256` text NULL, FK → `content_photos`, set only by the link route (imports,
edits, retire, restore never touch it). `admin_audit_action_check` gains `photo_upload`; a link is audited as
`content_edit` with `detail.photo: { from, to }`. TS list and S5 parity updated.

### 2.2 Staff routes (`@Roles(...)` per ADR-0002, was `@StaffOnly`; `@SkipClientVersion`)

- `POST /v1/admin/content/photos`: raw body (`image/jpeg` | `image/png`, <= 5 MB) through a route-scoped
  `roleBodyReader` (was `staffBodyReader`). A pure sniffer checks magic bytes and reads dimensions (JPEG SOFn, PNG IHDR); mismatch or out of range
  → 422 `photo_invalid` (new). Put first, then insert. 201 `{ sha256, contentType, byteSize, width, height }`, or 200 when
  already stored.
- `PUT /v1/admin/content/{module}/items/{id}/photo` `{ sha256 | null, expectedVersion }`: stale → 409
  `version_conflict`; unknown sha256 → 422 `photo_invalid`; unknown item → 404; bumps the item version under the module
  lock. One photo may serve several items (Tail reuses Identifier photos).
- `GET /v1/admin/content/photos/{sha256}`: staff preview.
- Items list and export gain a `photo` column (sha256 or blank); import ignores it.

### 2.3 Serving to players

Decided in [Backend ADR-0001](../adr/ADR-0001-image-storage-and-delivery.md) (user, 2026-11-03), replacing the
earlier backend-streamed recommendation (built in the media plan T1-T7; see the status note above): a Bunny pull zone on the shared zone with zone-wide token authentication;
the backend signs one HS256 link per file (24 h, no IP binding, key `BUNNY_CDN_TOKEN_KEY`, host `BUNNY_CDN_HOST`) only
for callers allowed to see the image (unverified: staff; published: any signed-in player and the website); an Edge
Rule blocks everything outside `/backend/content/photos/`; edge cache 1 year, device cache 24 h. The media row stores
the path, hash, size, type, dimensions, version and licence fields, never a URL. Trip open sends all ten links for
preloading; each Round issue re-sends its own.

## 3. Content releases

### 3.1 Tables (migration 0017; generated, immutability triggers appended by hand as in 0011)

`content_releases` (insert-only): `module`; `version` int >= 1, PK (module, version); `content_version`
`^r[1-9][0-9]{0,8}-[0-9a-f]{12}$` UNIQUE (module, content_version); `format` `'release.v1'`; `snapshot_key/sha256/
byte_size`; `package_key/sha256/byte_size`; `item_count` 1..2000; `deal_rule` (the adapter's rule id: `nearest-ranks`,
`lower-ranks`, `own-then-any-cap2`, `shuffle-all`, `matching-draw.v1`, `grid-draw.v1`); `flight_kind` (`choice` |
`matching` | `grid`); `coverage` jsonb; `created_at` (database clock); `created_by`; `note` <= 500.

`content_release_items` (insert-only): `module`, `release_version` (FK); `item_id`, `item_version`; `position` (natural
id order; the dealers' shuffles are positional); `rank`; `card_key` NULL; `photo_sha256` NULL (FK); `credit` NULL; `deal`
jsonb (the adapter's validated payload). PK (module, release_version, item_id); UNIQUE (module, release_version,
position).

`content_release_activations` (append-only; active = newest row per module): `id` identity PK; `module`;
`release_version` NULL (= deactivated); `previous_version`; `created_at`, `created_by`, `note`; index (module, id DESC);
trigger refuses UPDATE/DELETE. **No `facts_policy`** (§4.5).

`admin_audit_action_check` gains `release_create`, `release_activate`, `release_deactivate`. Single writer: only
`src/content/releases/release-store.ts` writes these tables (source-scan test).

### 3.2 Snapshot and package

```
release.v1:         { format, module, version, flightKind, dealRule, reference?, items: [
                      { id, itemVersion, rank, cardKey|null, photo: {sha256, contentType, width, height}|null,
                        credit|null, deal: <adapter payload> } ] }        // natural id order
release-package.v1: { format, module, version, contentVersion, items: [ { id, photo: {sha256, byteSize}|null, credit|null } ] }
```

`contentVersion` = `r<version>-` + first 12 hex of the snapshot sha256. `reference` holds module-level data an adapter
needs (e.g. Airport Spotter's code-to-name table). The package carries no answers.

### 3.3 Staff routes (`@Roles("admin")` per ADR-0002, was `@StaffOnly`; `@SkipClientVersion`)

- `POST /v1/admin/content/{module}/releases?dryRun=` `{ itemIds: string[] (1..2000, required, R-3), note? }` through a
  route-scoped 160 KB JSON reader. Under the advisory lock `content-release:<module>`, each item goes through the adapter's
  `toReleaseItem`; missing `card_key` frozen at creation (shared `militaryKeyOf` helper); coverage computed. Refusals:
  unknown id → 422 `unknown_item_ids`; not approved, malformed, non-portable answer, photo module item without a photo, or
  coverage < 10 at any rank → 422 `content_invalid` with `{ notApproved[], missingPhotos[], coverage }`; same snapshot
  sha256 as the newest → 409 `nothing_to_publish`; no mapping or adapter → 404; storage → §1.4. Next version = max + 1;
  one `release_create` audit row (counts, coverage, diff vs active). 201, or 200 for a dry run (writes nothing; returns
  eligible approved ids).
- `GET .../releases` → active (version, contentVersion, activatedAt) or null, release metadata, newest 50 activations.
  `GET .../releases/{version}` streams the snapshot (ETag = sha256).
- `POST .../releases/{version}/activate` `{ expectedActiveVersion: int | null, note? }`: coverage re-checked (422); stale
  → 409 `version_conflict`; already active → 409 `nothing_to_publish`; a rollback is activating an older version (audit
  `rollback: true`).
- `POST .../releases/deactivate` `{ expectedActiveVersion, note? }`: emergency stop; module returns to client mode.
- `POST .../releases/{version}/republish`: re-renders snapshot and package from the rows, checks digests, puts again.

### 3.4 Player delivery and manifest

`GET /v1/content/releases/{module}/{version}` serves the redacted package (signed-in, version gate, rate limiter; unknown
→ 404). Manifest module entry: `contentVersion` = active release's or null; `assetBundleUrl` stays null; additive
`release: { version, contentVersion, sha256, byteSize, url } | null`. Hash recipe `v: 2`; `generatedAtUtc` = newest of
documents' and activations' `created_at`.

## 4. Server dealing and answer checks (generic)

### 4.1 Module contract (`src/content/releases/release-modules.ts`)

```ts
interface ReleaseAdapter<Deal, Flight, Answer, Result> {
  module: ModuleId; flightKind: "choice" | "matching" | "grid"; dealRule: string; photos: "required" | "optional" | "none";
  toReleaseItem(row, photoSha, reference): { ok: true; item } | { ok: false; problem };
  coverage(pool): Record<Rank, number>;                                                    // capped at 10
  deal(pool, rank, seed): Array<{ itemIds: string[]; flight: Flight; answer: Answer; cardKey: string|null; aircraftKey: string|null }>;
  resultSchema: ZodType<Result>;
  derive(flight, answer, result, paidHint): { finished; errorCount; attempts } | { invalid: string };
}
```

Deal functions are pure, seeded by `tripId`, on the shared FNV-1a 32 + xorshift32 `DeckRandom` (`dealer.ts`), so fixtures
are portable. Choice adapters wrap `dealTrip` / `DEAL_POLICY`; each new choice policy is one map entry plus fixture cases
in `contracts/dealer.v1.json`. Matching and grid publish `contracts/matching.v1.json` and `contracts/grid.v1.json`.

### 4.2 Deal at open, one Flight per Round (R-1)

`POST /v1/trips` deals inside the existing transaction after the player lock and stores the deck (migration 0018):
`trips.deal_mode` (`client` | `dealt`, default `client`), `release_version`, `deck_format` (`choice.v1` | `matching.v1` |
`grid.v1`), `deck` jsonb (10 × `{ itemIds, flight, answer, cardKey, aircraftKey }`); CHECK `dealt` iff all set. A later
rule change, rollback or retire never changes a Trip in flight. The open response's `trip` gains `mode`,
`release: { version, contentVersion } | null`, `photos: [{ sha256, url }]` (<= 10) for preloading. `IssuedRound` gains
`flight: Flight | null`; a re-issued Round keeps its Flight; photo URLs are minted again.

```
choice:   { kind:"choice", itemId, photo:{sha256,url}|null, crop?:{x,y,width,height}, credit|null, options:[{id,label}]x4, correctIndex }
matching: { kind:"matching", boardId, seed, pairs:[{id,left,right,leftPhoto?:{sha256,url}}] }
grid:     { kind:"grid", boardId, width, height, letters, clueMode, targets:[{code,clue,cityClue,cells:[{row,column}]}] }
```

Unity already decodes every mechanic (`ApiWireModels.cs`). Timers are not sent (Unity `TripProfiles`; Josh question).

### 4.3 Result body for a dealt Round

Common: `usedHint`, `timeRemainingFraction`, `answerMs`.

| Kind | Body adds | Server derives | Validation (ASSUMPTION tests where Unity behaviour is inferred) |
|---|---|---|---|
| choice | `picks: int[]` (0..3, distinct, 0–4, tap order) | finished = last pick is `correctIndex`; errorCount = wrong picks; attempts = `picks.length` | correct index only last; wrong picks <= 3 − (hinted ? 1 : 0); at that maximum Missed; timeout = no correct pick |
| matching | `matches: [[leftPairId, rightPairId]]`; `revealed: pairId[]` | errorCount = mismatches; finished = all pairs matched or revealed; attempts = `matches.length` | ids on the board; a pair matched at most once; `revealed` <= 1 |
| grid | `selections: [[r1,c1,r2,c2]]`; `hinted: int[]` | found = selections equal to a target path (direction per `CodeSearchRound.TrySelect`); errorCount = the rest; finished = all found | cells inside; each target found at most once |

v1 fields (`finished`, `errorCount`, `attempts`, `aircraftKey`) optional in a dealt body; when present they must equal
the derived values (400 `invalid_request`). A v1-only body on a dealt Round, or a dealt body on a client-mode Round →
400. `usedHint` OR-ed with the paid hint; `answerMs` keeps its +2 s slack. `aircraftKey` and the Card key come from the
stored deck. Stored as `rounds.response jsonb` + `rounds.response_format`. The result response gains
`answer: { itemIds, finished, errorCount, attempts, cardKey } | null`; a replay reads it back.

### 4.4 `contentVersion` at open

Order: Idempotency replay → localDate → release check → abandon/complete the previous Trip (a refusal writes nothing; a
replay still works after an activation or rollback).

| Module state | Client `contentVersion` | Result |
|---|---|---|
| no active release | anything | client mode: v1 facts (today) |
| active | = active release's | dealt from the active release |
| active | a known release, not active | 409 `content_version_mismatch` + `activeContentVersion` (implementer's choice; Q-U5 unruled: a rollback takes effect at once; no build deployed) |
| active | unknown | 409 `content_version_mismatch` + `activeContentVersion` |

One new error code. A 409 opens nothing; the client re-reads the manifest and retries with a **new** Idempotency-Key
(a different intent; U14 narrowed 2026-11-02).

### 4.5 Rollout and other rules

- **Required only.** A module with an active release deals every Trip; no `facts_policy`, no `additive` (R-3: no build is
  deployed). A module transferred after launch is gated by `MIN_CLIENT_BUILD` (426). If a mixed mode is ever needed it is
  one nullable column on the activation log plus one row in §4.4.
- **Rollback does not cancel open Trips (R-3).** A Trip finishes on its stored deck; releases are never deleted; the
  30-minute expiry bounds exposure.
- **Deactivate** returns the module to client mode; Remote Config stays the player-facing kill switch.
- Deals use `trips.rank` (Active Rank, ruling 2026-10-29). Flagged, not resolved: nearest-ranks and Airport's any-rank fill
  can deal items above the Certified Rank in a Pleasure Cruise (J8 addendum). Unity's mocks still deal at Certified.
- Lock order (player → trip → Round) unchanged; no network call in any player transaction. Completion, Cards, awards and
  the Logbook unchanged.

## 5. Per-module plan

| Module | Content today | Backend importer | A Flight is | Unity today | Server dealing needs | Kind | Card | Images | Blocked by |
|---|---|---|---|---|---|---|---|---|---|
| **aircraft-identifier-military** | client sheet 2026-10-26 (31 rows); Unity bundle (30; `mil-a5` C-17 has no photo) | done | photo + 4 answers | `BuildMilitaryDeck` (ported) | adapter over `nearest-ranks`; fixtures exist | choice | yes (`mil:` + normalised answer, frozen) | 30 photos to upload | Josh C13/J8, C14; C-17 photo |
| **airport-spotter** | client sheet 2026-10-26 + 45 photos; Unity pack | **done (I1)**, `apt-a<N>`, Unity's 7 corrections as warnings | photo + 4 IATA codes; Trainee labels `CODE · Name` | `BuildAirportTrip`: own <= 6, then all other ranks, own top-up; distinct photos; <= 2 Flights per airport | policy `own-then-any-cap2` in `dealer.ts` (exact port) + fixtures; airport names (Q-U10) | choice | none | 45 photos | names source (Q-U10); 13 MB sheet vs 5 MB upload cap; client confirmations (row 10 photo, MUN→MUC, BKL/NEW, row 21 BOS) |
| **runway-identifier** | client sheet 2026-10-28 (499 rows, 22 diagrams); no Unity pack or dealer | **parked**: the real sheet cannot import under current rules (477 rows without a photo name; 77 duplicate codes, 33 differing; 201 rows "Check Pilot") | diagram + 4 IATA codes (names in the sheet) | none | rule to define (recommend `own-then-any-cap2`, Q-U11) | choice | none | 22 diagrams | **user rulings** (key, "Check Pilot", photo-less rows); client: duplicates, NYL, PBI, LIT name, remaining images |
| **identifier** (commercial) | client sheet 2026-09-28 (no family/photographer column); Unity bundle (31); website desk | none (I3) | photo + 4 answers | `BuildDeck` (`lower-ranks`, ported) | mapping + adapter; family from Unity `FAMILY_PREFIXES` port or a column; Card gate R1 | choice | yes (family, gated by `clipper-cards`) | ~31 photos | I3; family source; photo credit; C1/D-2 website desk migration |
| **tail-identifier** | demo pack (12 records we made from Identifier photos, crops, Trainee only); client sheet not delivered | none | cropped photo + 4 airlines | `BuildTailTrip` (shuffle whole pool, balanced answer slots) | mapping + `shuffle-all` + crop in `deal` | choice | none | reuses Identifier photos | client content or Q-U9 |
| **atc-match** | demo pack (20 airports from OurAirports); client sheet not delivered | none | board of 5/10/15 code↔city pairs by rank | stride formula; columns shuffled on device | mapping + `matching-draw.v1` + fixtures | matching | none | optional thumbnails | Q-U9; typed mode for Check Airman/Chief Pilot not built; Josh timers |
| **call-sign-match** | demo pack (20 airlines, FAA JO 7340.2); client sheet not delivered | none | board of 5 callsign↔airline pairs | same stride | same matching adapter | matching | none | none | Q-U9 |
| **code-search** | demo pack (10 reviewed Trainee boards); higher ranks generated at runtime with `System.Random` | none | grid + targets | Trainee: shuffle pack; above: generator | board-pack import (one item = one validated board), `WordGridPuzzleValidator` port, `grid-draw.v1`; do not port `System.Random` | grid | none | none | Unity board exporter; ladder values; ICAO codes at high ranks; Q-U9 |

Only the two Identifiers carry Clipper Cards. Tail, ATC and Call Sign items store `trainee` (their rank ladder is board
size or clock, not content).

## 6. Commercial Card gate into `clipper-cards` (slice R1)

`parseClipperCards` also returns `commercialKeys` (Cards with `module: identifier`), memoised through the verdict cache;
`commercialCardKeysInForce(tx)` reads it via `documentInForce`; with no `clipper-cards` row at all, fall back to
`SEED_COMMERCIAL_CARD_KEYS` and log once; `completeRound` passes the set and the default parameter is removed; a publish
that removes an `identifier` Card → 422 `content_invalid`. No migration. Prerequisite for transferring `identifier`.

## 7. Transfer order

| # | Module | Prerequisites |
|---|---|---|
| 1 | Military | R0–R4, P1–P2; 30 photos uploaded and linked (first: a production build cannot deal it locally) |
| 2 | Airport Spotter | I1 (done); Q-U10; M-AS; Unity parity on the new policy's fixtures |
| 3 | Runway Identifier | I2 (needs rulings); Q-U11; M-RW |
| 4 | Aircraft Identifier | I3 + R1 + M-ID; family source; website desk migration (C1/D-2); parallel with 2–3 once R4 lands |
| 5 | Tail Identifier | Identifier photos in the store; Q-U9 or client content |
| 6 | ATC Match, Call Sign Match | matching kind (M-MX); Q-U9; typed mode or Josh rulings |
| 7 | Code Search | grid kind (M-CS); Unity board exporter; ladder ruling |

## 8. Data model, errors, API

Migrations: 0016 (P1: `content_photos`, `content_items.photo_sha256`, audit `photo_upload`); 0017 (R2: releases, release
items, activations, triggers, audit actions); 0018 (R4: `trips` deal columns, `rounds.response/response_format`). Each
generated; second `db:generate` reports no changes; S5 parity lists in the same slice; a slice merging second regenerates
its migration on top. New TS lists `FLIGHT_KINDS`, `DECK_FORMATS`, `DEAL_MODES`. PlayerBalance: no new Step flags.
Errors: new `content_version_mismatch` (409), `photo_invalid` (422); reused `storage_unavailable`, `content_invalid`,
`nothing_to_publish`, `version_conflict`, `unknown_item_ids`, `not_found`, `invalid_request`, `forbidden`. Config:
`BUNNY_CDN_TOKEN_KEY`, `BUNNY_CDN_HOST` (ADR-0001). API: additive minor steps. UGS copy unchanged (`schemaVersion` 3).

## 9. Slices

| Slice | Contents | Depends on |
|---|---|---|
| R0 | pure: choice `derive`, `releaseContentVersion`, snapshot/package renderers, image sniffer, URL signer | — |
| R1 | Card gate (§6) | — |
| P1 | photo upload, link, staff GET (0016) | R0 |
| R2 | release store, create/list/get, Military adapter (0017) | R0, P1 |
| P2 | CDN link signer (ADR-0001), image links + licence fields on Trip open and Round issue, website image-record route | R0, P1 |
| R3 | activate, rollback, deactivate, republish, manifest `v: 2`, package route | R2 |
| R4 | dealt Trips (0018), `flight` on issue, choice result, `content_version_mismatch` | R0, R1, R2 |
| M-AS | Airport adapter + `own-then-any-cap2` + fixtures | I1, R4, Q-U10 |
| M-RW | Runway adapter | I2, R4, Q-U11 |
| M-ID | I3 importer + Identifier adapter | R1, R4 |
| M-TL | Tail importer + adapter | M-ID, Q-U9 |
| M-MX | matching kind: ATC + Call Sign mappings, `matching-draw.v1`, `contracts/matching.v1.json` | R4, Q-U9 |
| M-CS | grid kind: board-pack mapping, validator port, `grid-draw.v1`, `contracts/grid.v1.json` | R4, Unity exporter |

Waves: B1 = R0 ∥ R1 ∥ P1; B2 = R2 ∥ P2; B3 = R3 ∥ R4; B4 = M-AS ∥ M-RW ∥ M-ID; B5 = M-TL ∥ M-MX ∥ M-CS. Shared hot files
(`openapi.yaml`, `errors.ts`, `enums.ts`, `release-modules.ts`, `dealer.ts` `DEAL_POLICY`, `dealer-fixture.ts`, the
route-count and openapi tests) merge in slice order.

## 10. Open questions

Implementer's choices (taken unless the user objects): `contentVersion` = `r<v>-<12hex>`; deal from Postgres rows with the
Bunny snapshot verified at create; required `itemIds` (<= 2000); coverage 10 at every rank at create and activate; photo
modules refuse items without an uploaded photo; 5 MB / 4096 px photo limits; `card_key` frozen at creation; append-only
activation log; stored deck; generic `rounds.response`; one error code with `activeContentVersion`; a stale known
`contentVersion` refused (Q-U5); identical release → 409; manifest recipe `v: 2`; v1 fields in a dealt body must equal the
derived ones; picks/matches/selections rules as ASSUMPTION tests; a `republish` route; 64 MB LRU; no release FK on
`rounds`; `additive` dropped (Q-U8, follows R-3).

For the user:

- **Q-U7 photo route: decided** (user, 2026-11-03): Bunny CDN with token-signed links, see [Backend ADR-0001](../adr/ADR-0001-image-storage-and-delivery.md). Built (media plan T0-T8, API 0.16.0); not yet live on Bunny (T10) and not yet on dealt Trips and Rounds (T9 / R4).
- **Q-U9 non-client content.** ATC, Call Sign and Code Search packs are public reference data (OurAirports, FAA JO 7340.2);
  Tail's labels and crops were authored by us. Moving them into the backend as content **contradicts "use only
  client-supplied content"**. Recommended: wait for the client's content, or explicitly allow reference data for these four.
- **Q-U10 Airport names.** The sheet has codes only; Unity joins a pinned OurAirports names file (not client content).
  Recommended: store names per item (`labels: {code: name}`) from that file, so a release is self-contained — or ask Josh.
- **Q-U11 Runway dealer rule** (no Unity dealer). Recommended: Airport's `own-then-any-cap2`; the backend publishes fixtures
  and Unity's mock follows.
- **Runway importer (I2).** Key (code with exact duplicates collapsed / code + content / photo rows only / wait for Josh),
  "Check Pilot" (map to Check Airman with a warning / row error), photo-less rows (store / skip).
- **Airport Spotter upload size.** The delivered 13 MB sheet (embedded photos) exceeds the 5 MB import cap: re-save without
  photos, or raise the cap for staff imports.

For Josh: J8/C13 addendum (dealing above Certified in a Pleasure Cruise; now also Airport and Runway); per-module timers;
Runway Trainee label wording; ATC typed mode at Check Airman/Chief Pilot; Code Search ladder values; Runway duplicates,
"Check Pilot", NYL, PBI, LIT name, remaining 477 images.

For Unity: mocks deal at Certified Rank; 6 options at Check Airman in the profile but not in rounds; a Code Search board
exporter; parity tests for new choice policies and the matching and grid fixtures; Airport ids differ (`apt-a<N>` here,
`airport-apt-<iata>-<n>` in Unity; join on the corrected file name).

## 11. Contradictions flagged

- ARCHITECTURE "Admin content store" ("no release yet, nothing reaches players") goes stale with R3.
- ARCHITECTURE "Content via CCD/Remote Config with a Bunny backup is a follow-up" conflicts with the 10-29 manifest ruling
  and this design (Bunny primary, served through backend routes).
- ADR-0008 §4 "neither the backend nor the website reimplements [the validator]": the backend validates its own release
  invariants; Unity's validator can still gate the snapshot in CI.
- ADR-0008 §3 and S8 "closes the trust gap": overstated (§0).
- `trips-awards-logbook.md` §10 ("POST /v1/trips returns the dealt deck", "reports the chosen option") is replaced by
  per-Flight delivery and per-kind result lists.
- The dealer brief's "migration 0012 or later" for `trips.release_version` is now 0018.
- The earlier bundled-photo plan is withdrawn by R-2.
- R-4 amends the 2026-10-28 retire ruling.
- TASKS 5.2+ ("importers for the other seven modules") is replaced by §5 and §7.
- "Use only client-supplied content" vs the demo packs: Q-U9.
