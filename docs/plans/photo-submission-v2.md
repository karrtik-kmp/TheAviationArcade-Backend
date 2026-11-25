# Plan: photo submission v2 (the client's agreement of 2026-12-01 and form fields)

Status: **implemented (local) 2026-11-25; approved after the plan gate** 2026-11-25 (senior-lead and backend-expert, both "approve with changes", folded
in below). Source: brief `../docs/briefs/backend-photo-submission-v2.md` (website session, 2026-11-24). Agreement text:
`../website/lib/photo-submission-policy.ts` ("Photo Submission Policy and Image License Agreement", effective
December 1, 2026). User ruling 2026-11-24: an owner may move a v1 photo to v2 through `PUT .../rights`; v2 over v2 and
v2 to v1 stay refused; the v1 record is kept next to the v2 one.

One wave, one migration (**0028**), API **0.29.0**. Requests: v1 requests behave exactly as in 0.28.0. Responses:
**breaking for strict staff-media readers** (`MediaVersion` gains `title`, `MediaItem` gains `submission`; both schemas
are `additionalProperties: false` and the website parses them with `.strict()`). The game's calls and `ImageRef` do not
change. **Deploy order:** the website and Admin vendor 0.29.0 first (or ship together), then the backend goes to dev;
deploying and applying 0028 on dev needs the user's sign-off. A contract notice goes to the website/Admin
(`../docs/briefs/website-photo-submission-v2-contract.md`).

## Decisions

D1. **Statement code `v2_agreement_2026-12-01`**, one spelling on the wire and in the database (as v1). Sending it is
the photographer's acceptance, at that moment, of all three form confirmations: (a) at least 18 years old, (b) owns the
copyright or has the legal authority and permissions to submit the photo, (c) has read and agrees to the agreement of
version 2026-12-01, including worldwide commercial and promotional use without payment. The code names the agreement
version; a later agreement is a new code, never a reinterpretation. Stored on the version as v1 is:
`rights_statement`, `rights_stated_by` (verified principal), `rights_stated_at` (database clock). No `agreementVersion`
field (derivable from the code; gate). No separate booleans: they could only be true, and the code is the record.

D2. **Submission fields ride the upload in `X-Submission`**: base64url (RFC 4648 §5, no padding, canonical) of UTF-8
JSON `{ fullName, title, credit, instagramHandle?, instagramDisplayConsent? }`, written with non-ASCII characters
unescaped (the `JSON.stringify` default). Why a header: the upload body is the raw image (multipart is on the
"deliberately not built" list), a query string would put names in access logs, and two calls would break "required on
a v2 upload". Same pattern as Dropbox's `Dropbox-API-Arg`. `description` is not in it (header budget); the owner PATCHes
it after the upload, as today.
- Required with the v2 statement; refused (400) with v1.
- Decoding, all before the Idempotency-Key lookup, any failure 400 `invalid_request` with a message that never echoes a
  value: (1) length 1–6144 and `^[A-Za-z0-9_-]+$` (so a header sent twice, which Node joins with ", ", fails);
  (2) `Buffer.from(x, "base64url")` and re-encode must equal the input (rejects non-canonical trailing bits, as
  `decodeCursor`); (3) `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })` (a BOM reaches `JSON.parse` and
  fails); (4) `JSON.parse`, a plain object, a zod `strictObject`; (5) every string well-formed (`isWellFormed()`; lone
  surrogates refused). Rule (5) is also added to the shared `text()` rule. Duplicate JSON keys (last wins) are tolerated
  because the replay digest is over the normalised object (D10). 6144 stays under nginx's 8 KB per header line
  (`large_client_header_buffers` default, not overridden in `../server/server-setup.sh`) and Node's 16 KB total.
- `fullName`, `title`, `credit`: trimmed, 1–200 code points, no control characters (`text(1, 200)`).
- `instagramHandle`: optional; trimmed, one leading `@` stripped, then `^[A-Za-z0-9._]{1,30}$`; absent, `null`, empty
  (or `@` alone) after stripping = none. `instagramDisplayConsent`: optional boolean, default false; `true` without a handle is 400.

D3. **Where things are stored.** `title` is photo content, like `description`: per file version
(`media_versions.title`), copied forward exactly like `description`. The private fields (`fullName`, Instagram handle,
display consent) are about the person and must stay erasable, but a published version row is frozen for ever (0027
trigger). So they live in a new **mutable** table `media_submissions`, one row per media item (PK `media_id`), edited in
place: no new version, nothing in `?pending=true`, no admin publish needed. A v2 upload, v2 version upload or v2 move
upserts it from the submission (it fully replaces the three fields; an absent handle = null, absent consent = false).
The legal record of who accepted what and when stays on the version rows (statement, principal, time), which are kept.
Credit stays per version (`credit_name`, §7 "supplied at the time of submission").

D4. **Licence filled automatically for v2.** A v2 version gets `licenceName` = "Airplane Games Photo Submission Policy
and Image License Agreement (2026-12-01)" (constant next to the code), `licenceUrl` null (no invented link),
`creditRequired` true, `credit` = the submission's credit. On a v2 draft PATCH refuses a CHANGE to `licenceName` or
`licenceUrl` (422 `content_invalid`); `credit` (not to null), `sourceUrl`, `attributionText` stay editable;
`creditRequired` stays admin-only and, on a v2 draft, fixed at true (implementation: the v2 CHECK requires it, so a
change is 422 `content_invalid` rather than a 500; the agreement licence always credits the photographer).

D5. **Moving to v2 with `PUT .../rights` ALWAYS makes a new draft version** (never in place; gate): version + 1 of the
CURRENT DRAFT's file (sha256/type/size/dimensions), the draft's `description`, `title`, `sourceUrl` and
`attributionText` copied, then the submission's `title` replaces the title, licence per D4, statement v2 by the owner at
database now; the submission row is upserted. Every older row keeps its statement, stater and time (v1, the D1 import
marker, or none): that is the history of which terms covered the photo when.
Published versions are not rewritten (frozen; the evidence of what went live under v1). The v2 acceptance covers the
draft's photo from its `statedAt`; the LIVE version switches to v2 when an admin publishes the new draft (it shows in
`?pending=true`; no licence work needed, but the admin reviews the new public credit and title). No auto-publish.
Body: `z.discriminatedUnion("statement", …)`: `{ revision, statement: v1_own|v1_authorised }` or
`{ revision, statement: "v2_agreement_2026-12-01", submission }` (JSON, D2 field rules). Order after role, ownership
and the revision fence:
- v1: unchanged from 0.19.0 (draft null or `d1_private_review` and never published, in place; else 409).
- v2 when the draft already holds v2: 409 `rights_already_stated` (v2 over v2). v1 on a v2 draft: 409 (no downgrade).
- v2 otherwise (draft null, `d1_private_review` or `v1_*`, published or not): new version as above.
Audit `media_rights`: `version` = the version written (the 0027 backfill reads it so), `fromVersion`, `newVersion`,
`statement`, `previousStatement`, `previousStatedAt`, `previousStatedBy`, and `changes` with from/to for `credit`,
`licenceName`, `licenceUrl` and `title`; `submission: { fullNameChanged, instagramChanged }` (never values).
On 409 after a lost response, the client reloads: the move may already have happened (documented).

D6. **Uploads keep accepting v1 in 0.29.0**, and publishing accepts v1 or v2 (`PUBLISHABLE_RIGHTS` derived from the
enum, not a second literal list). Refusing v1 uploads is a later minor version once the website sends only v2 (the
user decides when). Guard now: **a v1 file upload to an item whose draft holds v2 is 409 `rights_already_stated`.**
Position: after the key lookup/replay, visibility and the fence, before storage (nothing stored for a refusal), and
repeated under the row lock after `findClaim`. So a retry of an earlier v1 upload that succeeded before the move still
replays 200. Invariant: once any version of an item holds v2, its draft holds v2. A v2 file upload to a v1 or v2 item
is fine.

D7. **`ImageRef` carries neither the Instagram handle nor the title in 0.29.0.** No content reads them; adding fields
later is additive. When it is added, the rule is simply the item's current consent flag (one mutable row), so a §8
withdrawal applies at once.

D8. **PATCH**, new optional keys next to `licence` and `description`; permission is decided on actual changes against
the stored value (as `creditRequired` is), so sending stored values is a 200 no-op:
- `title` (string or null): owner and admin; on a v2 draft it cannot become null (422).
- `fullName` (string or null), `instagram: { handle: string | null, displayConsent: boolean }` (both keys required;
  handle rule as D2; `""`/`"@"` mean null; consent true with a null handle is 400): written to `media_submissions` in
  place. The owner may set anything. A non-owner admin may only REMOVE (fullName to null, handle to null, consent to
  false), acting on a §8 or privacy request; any other change is 403 `forbidden`.
- A PATCH that only changes submission fields makes no version and leaves `draftVersion` alone; the item's `revision`
  moves. Mixed with licence/description/title changes, the version rule applies to those as today.
- 422 checks (v2 title/credit not null, v2 licenceName/licenceUrl fixed) run before any UPDATE, so no CHECK becomes a 500.
- Confirmed for the brief: a photographer already may PATCH their own item's `description` and licence fields
  (0.19.0); only `creditRequired` is admin-only.

D9. **Privacy.** `fullName` and the Instagram fields appear only in staff views of the item (owner or admin,
`MediaItem.submission`), never in `ImageRef`, `GET /v1/media` or `GET /v1/public/media`. No email is stored (the
token's account email; the backend keeps none). `admin_audit` (append-only) never holds a name or handle value, only
`changed` flags and the consent from/to. The publish gate refuses a v2 draft whose item has no `fullName` (e.g. erased),
422 `content_invalid`. Erasure is possible by PATCH (owner, or admin removing); a dedicated erase route is a user
question. Logs: a test captures the access log for a v2 upload and for a 400 on `X-Submission` and asserts neither the
header value nor the decoded name appears.

D10. **Replay compares the submission.** `media_upload_keys.submission_sha256` (nullable; null for v1): sha256 of
`JSON.stringify` of an object built in the fixed order `fullName, title, credit, instagramHandle,
instagramDisplayConsent` after trimming and `@` stripping, defaults written out (`null`, `false`). Pinned by a unit test
against a fixed digest. Replay needs same operation, item, bytes, statement and digest, else 422
`idempotency_key_reused`.

## Schema (migration 0028; `npm run db:generate`, then hand edits marked in SQL comments)

- First statement `SET LOCAL lock_timeout = '5s'` (as 0027).
- `media_versions`: add `title` text, CHECK `IS NULL OR length BETWEEN 1 AND 200`; `rights_statement` CHECK gains the v2
  code; new `media_versions_v2_submission_check`: `rights_statement IS DISTINCT FROM 'v2_agreement_2026-12-01' OR (title
  IS NOT NULL AND credit_name IS NOT NULL AND licence_name IS NOT NULL AND credit_required)`; publishable CHECK DROP +
  ADD … NOT VALID (by hand) with v2 in the IN list.
- New `media_submissions`: `media_id` bigint PK FK `media_items`; `full_name` text CHECK 1–200; `instagram_handle` text
  CHECK `~ '^[A-Za-z0-9._]{1,30}$'`; `instagram_display_consent` boolean NOT NULL DEFAULT false, CHECK `NOT consent OR
  handle IS NOT NULL`; `updated_at` timestamptz NOT NULL; `updated_by` text NOT NULL (1–256). No freeze trigger.
- `media_upload_keys`: add `submission_sha256` text, CHECK `IS NULL OR ~ '^[0-9a-f]{64}$'`.
- Enums: v2 code in `MEDIA_RIGHTS_STATEMENTS` and `MEDIA_PUBLISHABLE_RIGHTS`; constants `MEDIA_V2_STATEMENT`,
  `MEDIA_V2_LICENCE_NAME`. `EXPECTED_ENUM_CHECKS` updated; the v2 check keeps `IS DISTINCT FROM` (or goes in
  `RULE_CHECKS`). No new audit action.

## Files

- Slice A (implementer, code + tests): `src/db/enums.ts`, `src/db/schema.ts`, `drizzle/0028_*.sql` + meta,
  `src/content/media/{media.service,media.controller,media-view,media-submission (new)}.ts`, `test/schema-parity.ts`,
  new `test/media-submission-v2.e2e.test.ts`, new `test/migration-0028.e2e.test.ts` (0027 pattern), a unit test for
  the decoder and digest, small updates to existing media tests where a shape grew.
- Slice B (implementer, contract + docs, in parallel): `docs/openapi.yaml` 0.29.0, `docs/ARCHITECTURE.md`, ADR-0002
  note, `docs/TASKS.md`, the website/Admin notice brief.

## Tests (beyond the existing suites)

- Upload v2: 201, title/credit on the version, submission on the item, licence auto-filled; decoder 400s for `+`, `/`,
  padding, space, non-canonical last char, invalid UTF-8, BOM, `"\ud800"`, duplicate header, over 6144, bad JSON,
  unknown key, long field, bad handle, consent without handle; nothing written; v1 + `X-Submission` 400; `@` stripped;
  non-ASCII name round-trips.
- Replay: same everything 200; different submission 422; reordered JSON keys 200; v1 replays unchanged.
- Version upload: v2 on a v1 item 201; v2 on a v2 item 201; v1 on a v2 item 409; an earlier v1 key replayed after the
  move 200.
- PUT rights: v2 over unpublished v1 draft → new version, old row unchanged; v2 over published v1 → new draft, published
  row byte-identical, item in `?pending=true`, admin publish 200 and the live version is v2; v2 over `d1_private_review`
  → new version, imported row unchanged; v2 over v2 409; v1 over v2 409; precise 400s for v2 without / v1 with
  submission; non-owner admin 403; stale 409; two concurrent moves: one 200, one 409, one audit row.
- PATCH: v2 licenceName change 422, same value 200 no-op; title/credit to null on v2 422; non-owner admin sets fullName
  403, clears it 200, sends stored values 200 no-op; admin consent off 200, on 403; submission-only PATCH on a published
  item: no new version, not pending; edit making a new version copies `title`; v1 file version copies `title`.
- Publish: v2 draft with nothing typed publishes; v2 draft after fullName erased 422; raw SQL v2 row without title
  refused by the CHECK; a published v2 item's name and handle can be cleared.
- Privacy deep scan (`ImageRef`, `/v1/media`, `/v1/public/media`: no `fullName`, `instagram`, `title`, `submission`,
  `rights`); audit details hold no name or handle value; access log test (D9).
- Migration 0028 on a 0027 database with a pre-0019 published row, a published v1 row and a v1 draft: rows
  byte-identical (incl. `updated_at`), new title NULL, publishable check `convalidated = false` with v2, other new checks
  validated.
- Schema parity, openapi parity, typecheck, `npm test`, `npm run test:e2e`, build, `db:generate` clean, fresh migrate.

## Needs the user or the client

1. Live version after a v1 → v2 move switches on the admin's publish (D5); auto-publish would be a new rule.
2. If a newer unpublished file is ahead of the live one, the move covers the draft's file only; the live file stays under
   v1 until that draft is published. Acceptable, or should accepting v2 also cover the live file?
3. When to stop accepting v1 on uploads (D6), and whether v2 may be accepted before 2026-12-01 (legal, client).
4. Licence name wording (D4) and a link once the site's domain is final.
5. An admin erase route for a photographer's name and handle now, or with the account-deletion work (D9)?
6. Deploying 0.29.0 / migration 0028 to dev: after the website and Admin vendor it, with your sign-off.
