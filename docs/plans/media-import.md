# Plan: import website D1 photo proposals into backend media

Status: **draft, not approved.** Build after the user rules on the image description and rights-statement fields
(so the import can fill them). No live data needs moving yet: D1 holds local and preview test data only.

Source: user ruling 2026-11-04 (recorded by the website in `../docs/PROJECT_STATE.md`): photographer submissions live
in the backend and Bunny in every mode; existing D1 proposals are migrated to backend media.

## Shape (agreed with the website session, pending the user)

An **operator command**, not an HTTP route: `npm run media:import -- --bundle <dir> [--yes]`. An admin route that takes
an owner principal would let any admin token create items owned by someone else; a one-off migration does not justify
that surface. The command needs database and storage access, like the audited `roles:grant`.

The website writes the bundle: `manifest.json` plus the image files.

| Manifest field | From D1 (`submissions`) | Backend use |
|---|---|---|
| `sourceId` | `id` | Idempotency: a re-run reports "already imported" |
| `owner` | `owner_id` (full `firebase:<projectId>:<uid>` from the verified session) | Item owner. Project must equal the backend's Firebase project, else refused. Never derived from email, credit or name |
| `file`, `contentType`, `sha256` | `image_key` bytes, `image_mime`, `digest` | Same checks as upload (JPEG/PNG, 5 MB; D1 allowed 12 MB, so larger files are refused and reported) |
| `credit` | `payload.credit` | Draft licence `credit` |
| `rightsBasis` | `payload.rightsBasis` (`owner` / `authorized`) | Audit only (until a rights field exists) |
| `submittedAt` | `created_at` | Audit only |

Not imported: contact `email` (never stored or audited), the photographer display name, and editorial review state.
`creditRequired` is not accepted; it starts true.

**Licence: none.** The D1 consent covered "private editorial review" only and states it "does not grant a license to
publish". So `licenceName` stays empty (an admin cannot publish until a licence is obtained), and the audit note reads
"Imported D1 proposal: submitted for private editorial review only; no publishing licence granted (rightsBasis: …)".

Each entry becomes an `unverified` item owned by `owner` (version 1), audited as `media_import` (actor `operator:cli`;
sourceId, owner, rightsBasis, submittedAt). The new audit action needs a migration. A dry run prints a per-entry report
(would import / already imported / refused + reason); `--yes` writes. Running against real Bunny needs user sign-off.

## Open questions (user)

1. Confirm the no-licence rule above.
2. Which D1 `status` values are imported (pending, changes_requested, approved, rejected)? The suggested answer is
   everything except `rejected`.
3. Description and rights-statement fields on media (decide first; payload `description`, `aircraft`, `location`,
   `rightsBasis` would map onto them).
