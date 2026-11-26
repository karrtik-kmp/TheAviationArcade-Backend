# Plan: FAQ managed in the CMS (backend part), API 0.33.0

Status: **implemented (local) 2026-11-26; approved** 2026-11-26. The cross-repo plan `../website/docs/briefs/faq-cms-plan.md` passed its plan gate in the
website session (backend-expert, frontend-expert, senior-lead; changes folded in), reviewed against Backend 0.32.0. This
file pins the backend details. User: "Start now" (2026-11-26, Backend session), ahead of the pending dev deploy.
Client request (Josh, 2026-11-26): an FAQ he can adjust himself. SRS WB-FAQ-01, -02, -04, -05 (guides are a category).

One migration (**0032**), API **0.33.0**. Admin-only editing for now; Josh's role and where he edits are the user's
(plan decisions 1 and 2). Nothing is seeded; staff transcribe client text only.

## Decisions

F1. **A site document, not a game document.** New `SITE_DOCUMENT_NAMES = ["faq"]`; `STORED_DOCUMENT_NAMES` =
content + site, used by the two name CHECKs (`content_documents`, `content_drafts`) and by the staff routes.
`CONTENT_DOCUMENT_NAMES`, `documentsInForce`, `buildManifest`, `catalogVersion`, the Logbook ETag,
`GET /v1/content/documents/:name/:version` and its `isDocumentName` check stay game-only: `faq` is 404 there. The
staff list `GET /v1/admin/content/documents` stays as it is (game documents only), so strict Admin parsers do not
break; the FAQ is read through `GET /v1/admin/content/documents/faq/draft`.

F2. **Body `faq.v1`** (zod `strictObject`, checked on every read and write):
`{ format: "faq.v1", version, categories: [{ id, title, entries: [{ id, question, answer }] }] }`.
Ids `^[a-z0-9-]{1,64}$`; category ids unique; entry ids unique across the WHOLE document (the website anchors
`#faq-<id>` on one page). `title` 1–80, `question` 1–200, `answer` 1–2000 code points. At most 30 categories and 300
entries. Empty categories are allowed (the website hides them).

F3. **Text rule** (title, question, answer): CRLF and lone CR become LF; then the existing `text()` (trim, non-empty,
max code points, no U+0000, no lone surrogate); and no control character other than `\n` (stricter than the website
plan's wording, which named only U+0000: a tab or a bell in an FAQ answer is a typing accident, refused with 400; review 2026-11-26 adds U+2028/U+2029 and the
bidi controls U+200E, U+200F, U+061C, U+202A–U+202E, U+2066–U+2069). `\n`
is allowed only in `answer`. Plain text: blank line = paragraph; the website links `https://` URLs and site paths. No
HTML, no Markdown.

F4. **Implicit empty base.** Before the first publish the base is `{ format: "faq.v1", version: 0, categories: [] }`, so
the first draft needs no seed. The draft is the WHOLE working body, stored in `content_drafts.edits` as
`{ faq: <body without version>, history }` (unlike the overlay of the game documents, because the FAQ is free
structure).

F5. **PATCH by operations.** `PATCH /v1/admin/content/documents/faq/draft` body
`{ draftVersion, operations: [ 1..25 ] }` (`MAX_EDITS_PER_REQUEST`; the 16 KB body cap fits one 2000-code-point answer
even when every character takes 4 bytes). Applied in order, all or nothing:
- `{ op: "upsertCategory", id, title }`: new → appended; existing → renamed.
- `{ op: "removeCategory", id }`: only an EMPTY category (422 `content_invalid` otherwise; remove or move its entries
  first, so a click cannot delete answers in bulk).
- `{ op: "moveCategory", id, position }`: 0-based index in the resulting list.
- `{ op: "upsertEntry", categoryId, id, question, answer }`: new → appended to that category; existing in that
  category → updated; existing in another category → 422 (use `moveEntry`).
- `{ op: "removeEntry", id }`.
- `{ op: "moveEntry", id, categoryId, position }`: within or across categories.
Unknown ids, a position out of range, a duplicate id or a limit exceeded → 422 `content_invalid` with the operation's
index; shape errors → 400. The existing draft lock and `draftVersion` fence apply (stale → 409 as today). Implementation
(review 2026-11-26): every accepted PATCH is saved and returns the next `draftVersion`, also when the result equals the
current draft, as for the game documents.

F6. **Publish** (existing route): a draft with zero entries is 409 `nothing_to_publish` (also when it equals the
published body, as today). Inserts the next immutable version with its digest; one `content_publish` audit row with
the change list (FAQ text is public content written by staff, so it may appear in the audit's change list). Discard as
today.

F7. **Public read `GET /v1/public/faq`**: `@Public() @SkipClientVersion()`, the public throttle tier. 200
`{ format, version, publishedAt, categories }` of the version in force; `ETag` = quoted sha256 of the stored canonical
bytes; `Cache-Control: no-cache`; `If-None-Match` match → 304 (no body). 404 `not_found` before the first publish (no new
error code). Errors keep `Cache-Control: no-store`. An Authorization header is ignored.

F8. **Roles.** Staff routes stay `admin`; the demo account never holds `admin` (test: 403 on PATCH and publish).

F9. **Public rate-limit follow-up** (Backend TASKS, 2026-11-04: "revisit with the user before the public read gets a
consumer"). **Approved by the user 2026-11-26** ("Yes, keep it"), no code change: keep the per-IP public tier and no website secret (ruling
2026-11-04). After the hosting move the website's server calls the backend from the same host, so every guest shares one
IP budget; the website's FAQ reader caches 60 s with one request in flight and serves stale on error, so the FAQ costs
about one request a minute. Keep `RATE_LIMIT_PUBLIC_PER_MIN` at 60 and size it at hosting together with the guest media
read; `TRUST_PROXY` must equal the proxy hop count.

F10. **Dev → live copy** (user rulings 2026-11-26, given in the website session and relayed: Josh gets full `admin`;
Josh edits on dev, then the FAQ is copied to live; website plan item 10).
- `GET /v1/admin/content/documents/faq/export` (admin): the PUBLISHED FAQ as one JSON file
  `{ kind: "faq-export", format: "faq.v1", sourceHost, sourceVersion, publishedAt, sha256, categories }`. `sha256` is
  over the canonical bytes of `{ format, categories }` (no `version`, which differs per host), so the same content has
  the same digest everywhere. `sourceHost` is the request's host, informational only. 404 `not_found` before the first
  publish. `Content-Disposition: attachment; filename="faq-v<sourceVersion>.json"`, `Cache-Control: no-store`.
- `POST /v1/admin/content/documents/faq/import` (admin): body `{ draftVersion, file: <the export> }`, JSON with its
  OWN route-scoped body limit of 3 MB (300 entries of 2200 code points at 4 bytes each fit; the global 16 KB cap stays
  for every other route). Strict: another `kind` or `format`, a `sha256` that does not match the categories, or a
  body that fails F2/F3 → 422 `content_invalid` (shape 400), nothing written. Replaces the whole DRAFT (never the live
  version), under the same lock and `draftVersion` fence (stale → 409). Draft history gains an `import` entry; audit
  `content_import` with `{ document: "faq", sourceHost, sourceVersion, sha256, draftVersion }`. Publishing stays the
  normal publish route.
- Tests: a dev → live round trip (export on one database, import and publish on another) gives the same `sha256` and
  identical categories; a tampered file (digest mismatch), a wrong `kind`/`format`, a stale `draftVersion` and a
  non-admin are refused; a 1 MB valid file is accepted on the import route while the same size on PATCH is 413.

## Migration 0032

`SET LOCAL lock_timeout = '5s'` first; drop and re-add `content_documents` and `content_drafts` name CHECKs with
`'faq'` (0011/0013 untouched). Nothing else. `EXPECTED_ENUM_CHECKS` updated.

## Files

- Slice A (code + tests): `src/db/{enums,schema}.ts`, `drizzle/0032_*` + meta, `src/content/documents/*` (documents,
  drafts, document-store, draft-store, content-admin service/controller, a new `faq.ts` for the body, operations and
  text rule), a new public controller (e.g. `src/content/documents/faq-public.controller.ts`) and its module wiring,
  `test/schema-parity.ts`, `test/api.test.ts` (route count), new `test/faq.e2e.test.ts`, new `test/faq.test.ts` (pure
  operations and text rule), new `test/migration-0032.e2e.test.ts`.
- Slice B (contract + docs): `docs/openapi.yaml` 0.33.0, `docs/ARCHITECTURE.md`, `docs/TASKS.md`, the notice
  `../docs/briefs/website-faq-contract.md`.

## Tests

- Operations: each op; append/rename; remove non-empty category 422; cross-category upsert 422; positions; unique ids
  across categories; 30/300 limits; 25 operations; all-or-nothing on a failing later op; one entry at the 16 KB edge.
- Text: trim; CRLF/CR → LF; inner `\n` kept in answers, refused in titles/questions; tab, U+0000, lone surrogate 400;
  2000/200/80 code points (astral characters count once).
- Draft: first draft from the empty base; two PATCHes at one version (one 409); discard; publish then edit; publish
  of zero entries 409; publish of an unchanged draft 409.
- Isolation: after a FAQ publish the manifest bytes, `catalogVersion` and the Logbook ETag are unchanged;
  `GET /v1/content/documents/faq/1` 404; the staff list unchanged.
- Public: 404 before publish (no-store); 200 shape, ETag, no-cache; 304 on match; new ETag after a second publish;
  Authorization ignored; 429 on the public tier.
- Roles: photographer and demo account 403 on PATCH/publish.
- Migration 0032 on a seeded 0031 database: rows byte-identical; checks validated; `faq` accepted, an unknown name
  refused. Parity, openapi, full suites, `contracts:write` (expect no diff: `contracts/` is rules only).
