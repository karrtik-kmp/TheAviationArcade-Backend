# Plan: guest image read, rights statement and description, D1 import

Status: **approved after the plan gate** (senior-lead and backend-expert, both "approve with changes", folded in below)
2026-11-04. User rulings 2026-11-04: guests may see published images on the public website; media gets real backend
fields for a photo description and the photographer's rights statement (v1 wording below); the D1 import rules in
`media-import.md`; and, after the gate, the four answers under "User rulings (gate questions)". Real Bunny is not
contacted by any task here.

## Rights statement v1 (user-approved wording, shown by the website)

- Question: "Who holds the rights to this photo?"
- `own`: "I took this photo and hold the rights to it."
- `authorised`: "I'm authorised by the person or organisation that holds the rights."
- Consent (required): "I confirm this is true, and I agree that Airplane Games may publish this photo, after review, under
  the licence and credit I give for it."

The backend stores the statement code, not the wording. **One spelling everywhere** (wire and database): `v1_own`,
`v1_authorised`, and for imports `d1_private_review` (never accepted on the wire).

## User rulings (gate questions, 2026-11-04)

1. Admins may **not** upload a new file version to another photographer's item (403 `forbidden`): only the owner uploads
   files and states rights. This narrows ADR-0002's "admin includes every photographer permission" for file uploads and
   rights statements; record it in ADR-0002 and ARCHITECTURE. Admins still edit licences and descriptions, publish and
   withdraw.
2. The description is **staff only**: never on ImageRef, `GET /v1/media` or the guest route.
3. A new file version **copies the previous draft's description forward** (the licence still starts empty).
4. Import **refuses** an entry whose owner has no active `photographer` role row at import time (reported).

## Wave P: guest read (API 0.18.0)

P1. `MediaGuestController`, `GET /v1/public/media?ids=`: `@Public()`, `@SkipClientVersion()`, the same strict `ids`
query (shared module) and `MediaService.published(ids)` as `GET /v1/media`: `{ images: ImageRef[] }`, published only,
request order, 24 h links on the database clock, `cdn_not_configured` without a CDN. An Authorization header is ignored
(`@Public` already returns before reading it); a token on this route counts on the IP bucket. No owner/principal in the
body. Rate limit: the public tier (`RATE_LIMIT_PUBLIC_PER_MIN`, default 60). No route used that tier before (health is
`@SkipThrottle`).
Contract requirement for the website (its server calls, so every guest shares its egress budget): up to 50 ids per call;
cache each ImageRef and refresh ahead of `expiresAt` (under about 1 h left); keep serving cached refs on 429.
P2. Docs: dated amendment to ADR-0001 §8; ARCHITECTURE (public routes, "Who gets links", a signed link is still not a
"public image URL", hosting checklist: size `RATE_LIMIT_PUBLIC_PER_MIN` for the website egress, set `TRUST_PROXY`);
stale comments in `public.decorator.ts` and `app.module.ts`.
Tests: no token 200 and equal to `GET /v1/media`; garbage and expired tokens 200; published-only, order, duplicates;
400 shapes; deep scan finds no `owner`, `createdBy`, `statedBy`, `description`, `rights`; 429 with Retry-After; a valid
token counted on the IP bucket; route count in `test/api.test.ts`.

## Wave R: rights statement and description (migration 0019, API 0.19.0)

R1. Schema (`media_versions`, per file version):
- `rights_statement` text, CHECK IN (`MEDIA_RIGHTS_STATEMENTS` = `v1_own`, `v1_authorised`, `d1_private_review`);
  `rights_stated_by` text; `rights_stated_at` timestamptz (database clock). All-or-none without literals:
  `(rights_statement IS NULL) = (rights_stated_by IS NULL) AND (rights_statement IS NULL) = (rights_stated_at IS NULL)`.
- `description` text, CHECK `description IS NULL OR length(description) BETWEEN 1 AND 2000`.
- `media_imports` table (for Wave I, so I needs no migration): PK (`source_system`, `source_id`), `source_system` CHECK
  IN (`d1`), `source_id` length CHECK, `media_id` UNIQUE FK `media_items`, `owner`, `sha256`, `imported_at`.
- Audit actions `media_rights`, `media_import`.
- Publishable CHECK extended: a published version also needs `rights_statement IN (MEDIA_PUBLISHABLE_RIGHTS)`
  (`v1_own`, `v1_authorised`). DROP and re-ADD in 0019; ` NOT VALID` appended by hand to that ADD (drizzle cannot emit
  it) before 0019 is ever applied, with a SQL comment. Enums in `src/db/enums.ts`, both CHECKs registered in
  `EXPECTED_ENUM_CHECKS`.
R2. Upload carries the statement: `POST /v1/admin/media` and `POST .../{mediaId}/versions` require
`X-Rights-Statement: v1_own | v1_authorised`, validated in `imageRequest` before the key lookup (400 when missing or
other). Sending it is the uploader's consent; stored with stated_by = caller, stated_at = database now.
`POST .../versions` is **owner only** (ruling 1): a non-owner admin gets 403 `forbidden`, a non-owner photographer 404.
Replay: `replay()` reads the claimed version's `rights_statement` (via the existing FK) and requires it to equal the
header, else 422 `idempotency_key_reused`; no new column. Invariant: an uploaded version always has a `v1_*` statement
and R4 never rewrites one, so the version a key names is stable. A pre-0019 key replays as 422 (local data only).
R3. A licence/description edit that makes a new version copies `rightsStatement`, `rightsStatedBy`, `rightsStatedAt`
and `description` from the draft (named explicitly in the insert); an in-place edit never touches the statement. A new
file version (`addVersion`) copies the draft's description (ruling 3) and takes its own statement from the header.
R4. `PUT /v1/admin/media/{mediaId}/rights` `{ revision, statement: "v1_own" | "v1_authorised" }`: lock with the
caller's real admin flag; non-owner non-admin 404; non-owner admin 403 `forbidden`; then the revision fence (409
`version_conflict`); then eligibility: the draft's statement is null or `d1_private_review` AND it was never published
(`draftVersion !== publishedVersion && draft.publishedAt === null`), else 409 `rights_already_stated` (new error code).
Writes the draft in place, bumps revision, audits `media_rights`.
R5. Publish gate: the draft needs a `v1_*` statement, else 422 `content_invalid` ("the photographer's rights statement is
missing"), checked before any version UPDATE so a pre-0019 row never reaches the CHECK (23514 would be a 500).
R6. Description: PATCH body `{ revision, licence?, description?, note? }` with at least one of `licence`/`description`;
`description` is a string or null. Validator: trim, CRLF to LF, `\n` the only control character allowed, 1-2000 code
points. Included in change detection, the no-op check and the audit `changes`; same new-version rule as the licence.
Owner photographer and any admin may edit it. Staff views: `MediaVersionView` gains `description` and
`rights: { statement, statedAt, statedBy? } | null` (`statedBy` for admins only, via an `includeOwner` flag on
`toVersionView`). ImageRef is built from `.licence` only.
R7. Docs: ADR-0002 and ARCHITECTURE record ruling 1 and R4 (owner-only file uploads and statements).
Tests:
- R1: all-or-none CHECK; description length CHECK; old rows null; parity lists.
- R2: missing/unknown header 400; non-owner admin version upload 403, non-owner photographer 404; same key and bytes with
  another statement 422, same statement 200 replay (create and version).
- R3: licence-only edit on a published item keeps statement and description on the new version; new file copies the
  description, not the licence.
- R4: owner 200; non-owner admin 403; non-owner photographer 404; stale 409; v1 already or published 409
  `rights_already_stated`; two concurrent calls at one revision: one 200, one 409, one audit row.
- R5: publish without v1 422; a raw-SQL pre-0019 published row, withdrawn, then publish: 422 and nothing changed.
- R6: description-only PATCH; neither field 400; CRLF normalised; tab refused; deep scan of ImageRef, `/v1/media` and the
  guest route finds no `description`/`rights`/`statedBy`; photographer never sees `statedBy`.
- `npm run db:generate` clean after the hand edit; `npm run contracts:write`; openapi parity; version bump.

## Wave I: D1 import command (no migration, no API change)

As `media-import.md`, with:
- `--yes` refused unless `BLOB_STORE=bunny` (exit 2): the default memory store is per process, so a CLI write would be
  lost. A Bunny target needs user sign-off. Dry run works with any store and never writes a blob. Tests run the write
  path in-process with an injected `MemoryBlobStore`.
- Idempotency by `media_imports` (`ON CONFLICT DO NOTHING RETURNING` in the entry's transaction); same owner and sha256
  = "already imported"; different = "conflict" (refused).
- One transaction per entry: item (owner = manifest owner, checked with `uidOfAccountPrincipal` against the configured
  project, and refused without an active photographer role: ruling 4), version 1 with `rights_statement =
  d1_private_review`, stated_by = owner, stated_at = D1 `created_at` (UTC, refused if unparseable or in the future),
  description composed from the payload (same validator; over 2000 or bad characters refused, never truncated or
  stripped), the `media_imports` claim, audit `media_import`.
- Actor `operator:<os user>` as in `roles:grant`, also used for `created_by`/`updated_by`.
- Blob first with sha256 read-back, through a new `MediaService` method reusing the upload checks (sniff, 5 MB); manifest
  `sha256`/`contentType` must match the computed ones; `file` is a bare filename inside the bundle (no `..`, absolute
  path or symlink); `status: rejected` refused.
- Exit codes as `roles:grant`, plus one for partial success. Per-entry report.

## Order

P, then R, then I. Each wave: implementer(s) with file ownership, one independent review, fresh-database verification,
focused commit, push, E: backup, contract notice to website (and Unity when `contracts/` changes).
