# Plan: import website D1 photo proposals into backend media

Status: **built (Wave I, 2026-11-04; not yet run against any real store).** Rulings: licence and status rules by the user
2026-11-04; the description and rights-statement fields exist since migration 0019; the plan gate is in
`media-rights-and-public.md`. No live data needs moving yet: D1 holds local and preview test data only.

Source: user ruling 2026-11-04 (recorded by the website in `../docs/PROJECT_STATE.md`): photographer submissions live
in the backend and Bunny in every mode; existing D1 proposals are migrated to backend media.

## Shape

An **operator command**, not an HTTP route: `npm run media:import -- --bundle <dir> [--yes]` (`scripts/media-import.mjs`, a thin
shell around `src/content/media/media-import.ts`, which the e2e tests run in-process with an injected `MemoryBlobStore`). An admin
route that takes an owner principal would let any admin token create items owned by someone else; a one-off migration does not
justify that surface. Like `roles:grant` it loads the server's own config (`loadConfig`), uses a small pool, prints no secrets and
audits as `operator:<os user>`.

- **No `--yes`: dry run.** Works with any `BLOB_STORE`. Reads the database (existing claims, roles) and the bundle files; never
  writes a row, an audit entry or a blob (the CLI hands it a blob store that refuses every call).
- **`--yes`: refused (exit 2) unless `BLOB_STORE=bunny`.** A memory store is per process, so a CLI write would be lost. Running
  against real Bunny needs user sign-off.
- Exit codes: 0 all entries fine; 1 unexpected failure, or entries failed and none imported; 2 refused by arguments, settings or
  manifest (nothing contacted); 3 entries refused and none imported; 4 partial success.

## Manifest format (final)

`manifest.json` in the bundle directory, at most 10 MB, strict (an unknown key anywhere is refused; there is no email field):

```json
{
  "version": 1,
  "source": "d1",
  "entries": [
    {
      "sourceId": "d1-submission-id",
      "owner": "firebase:<projectId>:<uid>",
      "status": "pending | changes_requested | approved | rejected",
      "file": "photo-1.jpg",
      "contentType": "image/jpeg | image/png",
      "sha256": "<64 lowercase hex>",
      "credit": "Photographer name",
      "rightsBasis": "own | authorized",
      "submittedAt": "2026-10-01T12:00:00Z",
      "description": "optional free text",
      "aircraft": "", "airline": "", "registration": "", "location": "", "airportCode": "", "capturedOn": "",
      "title": "", "factualSource": "", "rightsEvidence": ""
    }
  ]
}
```

Required: `sourceId` (1-128), `owner`, `status`, `file`, `contentType`, `sha256`, `rightsBasis` (`own` or `authorized`: D1
stores `owner | authorized`, and the website's export maps `owner` to `own`; `authorized` keeps the D1 spelling, not the wire
spelling `authorised`), `submittedAt`. The rest are optional strings.

**Whole-run refusals (exit 2, nothing imported):** `manifest.json` missing, not a regular file, over 10 MB or not valid JSON; any
schema violation in any entry (an unknown key, a missing required field, a `status` or `rightsBasis` outside its list, a non-string
value, or a length cap: `sourceId` 1-128, `owner` 512, `file` 255, `contentType` 100, `sha256` 100, `submittedAt` 64); `version`
other than 1 or `source` other than `d1`; more than 5000 entries; a `sourceId` listed twice. **Everything else is per entry**
(owner project and role, rejected status, path, file, size, type, digest, date, credit, description): a bad entry is reported as
refused and never stops the others.

| Field | Backend use |
|---|---|
| `sourceId` | Idempotency key in `media_imports` (`source_system` `d1`) |
| `owner` | Item owner. Must be `firebase:<configured project>:<uid>` (`uidOfAccountPrincipal`) and hold an ACTIVE role: `photographer`, or `admin`, which the API's `holds()` (ADR-0002 decision 3) treats as holding photographer. Revoked, blocked, pending, rejected or no row: refused. Never derived from email, credit or name |
| `status` | Audit only. `rejected` is refused; the others are imported |
| `file` | A bare filename inside the bundle: no `..`, separator, drive colon, absolute path or symbolic link; must be a regular file |
| `contentType`, `sha256` | Must equal the sniffed type and the computed digest. The upload checks are `MediaService.checkImage` (JPEG/PNG by bytes, at most 5 MB, side limit), the write is `MediaService.storeImage` (put, read back, compare sha256): one implementation shared with the upload routes |
| `credit` | `credit_name` (1-200 characters, one line, no surrounding whitespace; absent, empty or only spaces = none). `credit_required` starts true |
| `rightsBasis` | Audit only |
| `submittedAt` | ISO 8601 UTC with `Z`, a real date, not in the future; becomes `rights_stated_at` |
| `description` + `title`, `aircraft`, `airline`, `registration`, `location`, `airportCode`, `capturedOn`, `factualSource` | Composed into the staff-only description (below) |
| `rightsEvidence` | Not in the description (it may exceed its 2000 cap): kept verbatim in the `media_import` audit detail (below) |

**Description composition.** The free `description` (trimmed), then, after one blank line, one line per present labelled field in
this order: `Title: …`, `Aircraft: …`, `Airline: …`, `Registration: …`, `Location: …`, `Airport: …`, `Captured on: …`,
`Facts source: …`. A whitespace-only value counts as absent; nothing at all stores no description. The result goes through
`normaliseMediaDescription` (CRLF to LF, 1-2000 code points, `\n` the only control character). A control character anywhere (also at
an edge), a labelled value with a newline (except `title` and `factualSource`, below), or a result over 2000 characters **refuses
the entry**; nothing is truncated or stripped.

**`title` and `factualSource` collapse instead of refusing newlines (user ruling 2026-11-04).** D1 allowed internal newlines in
these two (D1 limits: `title` 160, `factualSource` 600, `rightsEvidence` 2400), so every whitespace run (newlines and tabs
included) becomes one space and the ends are trimmed, which keeps the text without refusing the photo. Empty after that = absent.
Over 160 (`title`, code `bad_title`) or 600 (`factualSource`, `bad_factual_source`) code points after collapsing, or any other
control character: refused. The other labelled fields keep the stricter refuse-on-newline rule.

**`rightsEvidence`.** CRLF to LF, trimmed; `\n` and `\t` allowed, any other control character (NUL included, which JSONB cannot
hold) or more than 2400 code points refuses the entry (`bad_rights_evidence`). Empty = the audit key is omitted. Otherwise it is
stored verbatim, newlines and all, as `rightsEvidence` in the audit detail. Staff-only; no migration and no API change.

Not imported: contact `email` (not in the schema at all, never stored or audited), the photographer display name, editorial review
state.

## What one entry writes

One transaction per entry, after the blob is written and read back (a blob is content-addressed, so one left by a failed
transaction is harmless):

1. `media_items`: owner = manifest owner, `unverified`, draft version 1, `created_by` / `updated_by` = `operator:<os user>`.
2. `media_versions` version 1: `rights_statement` `d1_private_review`, `rights_stated_by` = owner, `rights_stated_at` = `submittedAt`,
   credit, **no licence** (`licence_name` empty), the composed description.
3. `media_imports` claim, `INSERT … ON CONFLICT DO NOTHING RETURNING`. Lost race: the transaction rolls back and the entry is
   re-read: same owner and sha256 = "already imported", otherwise "conflict" (refused).
4. Audit `media_import` (actor `operator:<os user>`; detail: `sourceId`, `owner`, `status`, `rightsBasis`, `submittedAt`, `mediaId`,
   `rightsEvidence` when present, and the ruling-1 `note`; never an email).

The role is checked again inside the transaction with `FOR SHARE`, which waits for a concurrent revoke or block. Files (and the
manifest) are read through an open handle with `O_NOFOLLOW` where the platform has it, after an lstat check, with the size taken from
the handle and at most cap + 1 bytes read. A re-run only reports "already imported" for entries already claimed (checked
before any file is read).

**Licence: none.** The D1 consent covered "private editorial review" only and states it "does not grant a license to publish". So an
imported item cannot be published until its owner states rights v1 (`PUT /v1/admin/media/{id}/rights`) and a licence is set; then an
admin publishes (tested end to end through the routes).

## Rulings (user, 2026-11-04, relayed by the website session)

1. No-licence rule confirmed: imported items have an empty `licenceName` and cannot be published until the photographer grants a
   licence; `credit` carries over; email is left out; the audit row carries this note (`detail.note`):
   "Imported D1 proposal: submitted for private editorial review only; no publishing licence granted (rightsBasis: <own|authorized>)."
2. Import every D1 `status` except `rejected` (pending, changes_requested, approved). Rejected proposals stay in D1 and are
   deleted with it.
3. (Gate ruling 4) An owner without an active photographer role (an active admin also qualifies, per `holds()`, ADR-0002) is
   refused and reported.
4. Description and rights-statement fields exist (migration 0019); the import fills them as above.
