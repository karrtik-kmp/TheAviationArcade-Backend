# Plan: review feedback for photos (decline / changes requested), API 0.30.0

Status: **approved after the plan gate** 2026-11-25 (senior-lead and backend-expert, both "approve with changes", folded
in below); **implementation waits for the user's go-ahead** and the answers under "Needs the user". Asked by: the Admin
session (Desks and Integration setup, 2026-11-25, Admin plan `../Admin/docs/A3_FIX_WAVE.md` rev 4); the user approved
planning it as 0.30.0 ("Yes, plan 0.30.0", 2026-11-25). Builds on 0.29.0 (`photo-submission-v2.md`, Backend `ef16242`).

## Why

Today an admin can only publish or withdraw. An unsuitable upload, or one with a bad credit, stays `unverified` for ever
and the photographer hears nothing; a PATCH `note` reaches only the audit row. The old D1 desk had "changes requested"
with a note. 0.29.0 adds a second case: an owner's v1 → v2 move on a LIVE photo makes a pending draft that an admin may
need to send back (wrong credit or title) without touching the live version.

One migration (**0029**), API **0.30.0**.

## Decisions

R1. **A review is a sub-record of the item, not a new `MediaState`.** `MediaState` stays `unverified | published |
withdrawn`, so the game, the guest route, Military preparation and releases, every `state` check and the Admin's closed
state enum are untouched, and a decision can apply to a published item's pending draft. New nullable columns on
`media_items` (mutable; items are not frozen): `review_decision` (`changes_requested` | `declined`), `review_reason`
(1–500 code points, newlines allowed), `review_version` (the draft version decided on), `review_decided_by`,
`review_decided_at`. Rejected: new states (they touch every state check and the `published = publishedVersion IS NOT
NULL` invariant, and cannot express "send back this pending change on a live photo").

R2. **Route `POST /v1/admin/media/{mediaId}/review`**, admin only, strict body, a union on `decision`:
`{ revision, decision: "changes_requested" | "declined", reason }` or `{ revision, decision: null }` (withdraw the
decision and erase its reason; gate). Order: role, 404, revision fence (409 `version_conflict`), eligibility (409
`version_conflict` with a message, as `withdraw`):
- **Reviewable items in this wave:** `unverified`, or `published` with a pending draft (`draftVersion >
  publishedVersion`). Withdrawn items are not reviewable (gate: otherwise a cleared withdrawn item falls out of every
  queue). `declined` only on `unverified`. `decision: null` on an item with no review is a no-op.
- A new decision replaces the current one; `declined` → `changes_requested` is how an admin reopens a declined item.
- **No-op:** same decision, same normalised reason, and `review_version === draftVersion` → 200, nothing written, no
  revision bump, no audit row, `decidedBy` stays the first admin. A retry after a lost response (old revision) is 409
  `version_conflict` like publish/withdraw; documented ("reload; it may already be done").
- One locked transaction: the columns are written in the same `bump` UPDATE (revision + 1), audit `media_review`.
  Admins may review their own uploads.
- Reason: the description normaliser with its maximum as a parameter (description 2000, reason 500) plus the well-formed
  string check (lone surrogates refused), CRLF to LF, `\n` the only control character, trimmed.

R3. **Who counts as the owner.** Clearing is decided by identity: a committed write by `principal === item.owner`
clears `changes_requested`, whatever the caller's role. The `declined` block (R4) applies to `principal === item.owner
&& !isAdmin`: an admin who owns the item is treated as an admin (never blocked). A non-owner admin's writes never clear.

R4. **What clears a review.**
- Publish clears either decision, in the same UPDATE that sets `state`; the `media_publish` detail gains
  `reviewCleared: <decision>`.
- An owner write that COMMITS a change clears `changes_requested`: a new file version, a PATCH that changes anything
  (licence, description, title, fullName, instagram; a submission-only change counts), a `PUT .../rights`. The item goes
  back to `?review=none`. The write's own audit row gains `reviewCleared: "changes_requested"`; absent when nothing was
  cleared. The clear rides the existing `bump` UPDATE, never a second one.
- Not cleared by: a no-op PATCH (it stays the early return: no bump, no audit row, so an owner cannot dismiss a request
  by sending stored values), an idempotent replay, a non-owner admin's PATCH (an admin fixing a typo must not cancel their
  own request; such a PATCH may make a new version, so `review.version < draftVersion` is possible and shown).

R5. **`declined` blocks the non-admin owner**, with the NEW 409 code `media_declined` (the reason is in the item, never
in the message), except for erasure: a PATCH whose only changes REMOVE private fields (fullName → null, handle → null,
consent → false; the same test as the non-owner-admin rule) is allowed and does not clear `declined`. Positions:
- addVersion unlocked: key lookup/replay → 404/403 → fence (with the twin replay) → `media_declined` → D6 v1-over-v2 →
  inspect/store. Locked: lock → 404/403 → key claimed → fence → `media_declined` again → D6 → insert.
- setRights: lock → 404/403 → fence → `media_declined` → `rights_already_stated`.
- edit: lock → 404 → fence → compute changes → `creditRequired` 403 → non-owner-admin 403 → `media_declined` (unless
  removal-only) → v2 422 → no-op return → write.
An admin may PATCH, publish (clears it), reopen with `changes_requested` or withdraw the decision.

R6. **Who sees it.** `MediaItem` gains the required key `review`: `null`, or `{ decision, reason, version, decidedAt }`
plus `decidedBy` for admin callers only (as `owner` and `rights.statedBy`). Staff routes only; never in `ImageRef`,
`GET /v1/media` or `GET /v1/public/media` (those read selected columns). Default: the owner sees the reason word for
word (user question 1).

R7. **Queue filter.** `GET /v1/admin/media` gains `?review=none|changes_requested|declined`, combinable with `state`
and `pending`. "Photos to review" is exactly `?state=unverified&review=none` plus `?pending=true&review=none`.
Cursor key: `(<state>|pending|-)` plus `+<review>` only when `review` is given; regex
`^m1\.((?:[a-z]+|-)(?:\+[a-z_]+)?)\.([1-9][0-9]{0,14})$`, canonical re-encode kept. Without `review` the key is exactly
0.29.0's, so old cursors still decode; `?pending=true` and `?pending=true&state=published` still share a key.

R8. **Audit.** New action `media_review`. Detail `{ mediaId, decision (or null), previousDecision, reviewedVersion,
revision, fromState, reasonLength }`: `reviewedVersion`, not `version`, because in this repo `detail.version` names a
version row that was written (0027 backfill) and a review writes none. The reason TEXT is never in the append-only audit
(0.29.0 D9: free text about a person's photo may name them). Only the current reason is kept; it is overwritten by the
next decision, erased by `decision: null`, cleared by an owner fix or a publish (user question 2). `review_reason` is
listed in ARCHITECTURE as data the account-deletion work must clear; the openapi `AuditEvent.detail` note says
`media_review` holds only `reasonLength`. No `audit-read` projection is needed (no free text).

R9. **The Admin's smaller asks.**
- `AuditEvent.action` as an open set: **not in this wave** (gate). The openapi enum is closed and a test pins it;
  opening it is a real contract change. The Admin keeps parsing unknown actions leniently, which is safe.
- Count / `hasMore`: not built; `nextCursor !== null` already means "more" (documented).
- List thumbnails: not built (full uploads up to 5 MB; real thumbnails need resizing or a CDN optimiser, on the
  "deliberately not built" list). Follow-up.
- D1 imports with status `changes_requested` land as `review=none` (in the queue, without the old note): the import keeps
  the status as evidence but creates no decision. Recorded, no change.

## Contract and deploy

Requests additive. Responses: `MediaItem.review` is a new required key, and `Error.code` gains `media_declined`, so
**breaking for strict staff-media readers and strict error parsers**. A strict client on 0.30.0 also fails against a
0.28 backend (missing `submission`, `title`, `review`). So the backend (migrations 0028 and 0029), the website and the
Admin go to dev **in one window**, after both clients vendor 0.30.0; deploying and migrating dev needs the user's
sign-off (user question 3). The brief to the website and Admin also says the reopen path (`declined` →
`changes_requested`) and `decision: null` go beyond their proposal.

## Schema (migration 0029)

`SET LOCAL lock_timeout = '5s'` first. `media_items`: the five nullable columns (catalog-only); CHECKs: decision enum
(`EXPECTED_ENUM_CHECKS`), reason length, `review_decided_by` length 1–256, all-or-none without literals
(`num_nulls(...) IN (0, 5)`), `review_version BETWEEN 1 AND draft_version`, `review_version IS NULL OR
published_version IS NULL OR review_version > published_version`, and the rule CHECK `review_decision IS DISTINCT FROM
'declined' OR state = 'unverified'` (in `RULE_CHECKS`). `admin_audit_action_check` DROP + ADD with `media_review`. Each
ADD CHECK scans its table under ACCESS EXCLUSIVE (`admin_audit` is the largest table; same pattern as 0013–0024, fine at
this size); `lock_timeout` bounds only the wait for the lock.

## Files

- Slice A (implementer, code + tests): `src/common/errors.ts` (`media_declined`), `src/db/{enums,schema}.ts`,
  `drizzle/0029_*` + meta, `src/content/media/{media.service,media.controller,media-view,media-description}.ts`,
  `test/schema-parity.ts`, `test/admin-audit.e2e.test.ts` (a `media_review` sample + leak scan),
  `test/content-publish.test.ts` (the pinned action list), `test/openapi.e2e.test.ts` (sample shapes), new
  `test/media-review.e2e.test.ts`, new `test/migration-0029.e2e.test.ts`, `review: null` in existing shape tests.
- Slice B (implementer, contract + docs): `docs/openapi.yaml` 0.30.0 (route, `MediaReview`, `MediaReviewRequest`,
  `MediaItem.review`, list `review` query, `media_declined` in `x-error-codes` of the versions, PATCH and rights routes and
  in `Error.code`, the audit action and its detail note, `nextCursor` = more), ARCHITECTURE (incl. account-deletion
  note), TASKS, the brief `../docs/briefs/website-media-review-contract.md`.

## Tests

- Route: changes_requested and declined on unverified 200; declined on a published item 409; changes_requested on a
  published pending draft 200, live version unchanged; withdrawn item 409; nothing to review 409; stale 409; non-admin
  403; no-op (and not a no-op once the draft moved); stale retry 409; reopen; `decision: null` erases the reason; reason
  rules (empty, 501, tab, lone surrogate refused; newline kept).
- Clearing: owner version upload / PATCH (incl. submission-only) / rights clears and the item is back in
  `?review=none`, audit `reviewCleared`; no-op owner PATCH keeps review and revision; replay of a key claimed before the
  review is 200 and does not clear; non-owner admin PATCH keeps it (incl. a new version: `review.version <
  draftVersion`); publish clears both, audit `reviewCleared`; an admin-owner's own write clears.
- Declined: owner version upload, PATCH, rights 409 `media_declined`, nothing stored or written; owner removal-only PATCH
  200 and still declined; admin-owner not blocked; precedence (declined + stale → `version_conflict`; declined +
  v1-over-v2 → `media_declined`; declined + non-owner admin upload → 403); admin PATCH and publish work.
- Visibility: owner sees `review` without `decidedBy` in get, list and replay; admin sees it; deep scan of `ImageRef`,
  `/v1/media`, `/v1/public/media`; audit detail and access log hold no reason text.
- List: each `review` value with state and pending; a 0.29.0 cursor still decodes; a review cursor without `review` 400
  and the reverse.
- Concurrency: review vs owner upload, owner PATCH, owner rights, publish, each at one revision: one wins.
- Migration 0029 on a seeded 0028 database (unverified, published with pending draft, withdrawn, audit rows): rows
  byte-identical apart from new nulls; every new CHECK validated; one violation per CHECK; `media_review` accepted, an
  unknown action refused; `admin_audit` append-only triggers still enabled. Parity, openapi, full suites.

## Needs the user

1. May the owner see the admin's reason word for word? Default yes (it is written for them).
2. Keep only the current reason (default), or keep past feedback in a mutable history table (still out of the audit)?
3. Deploy: backend (0028 + 0029), website and Admin to dev together at 0.30.0 after both clients vendor it, with your
   sign-off. Agreed?
4. Email to the photographer: none planned (no mail sending exists; the website shows it on "my photos"). Agreed?
