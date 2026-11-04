# Plan: import website D1 photo proposals into backend media

Status: **draft; the licence and status rules were ruled by the user 2026-11-04; the operator-command shape and the plan gate are still to be approved.** Build after the user rules on the image description and rights-statement fields
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
| `status` | `status` | `rejected` is refused; others imported (audit only) |

Not imported: contact `email` (never stored or audited), the photographer display name, and editorial review state.
`creditRequired` is not accepted; it starts true.

**Licence: none.** The D1 consent covered "private editorial review" only and states it "does not grant a license to
publish". So `licenceName` stays empty (an admin cannot publish until a licence is obtained), and the audit note reads
"Imported D1 proposal: submitted for private editorial review only; no publishing licence granted (rightsBasis: …)".

Each entry becomes an `unverified` item owned by `owner` (version 1), audited as `media_import` (actor `operator:cli`;
sourceId, owner, rightsBasis, submittedAt). The new audit action needs a migration. A dry run prints a per-entry report
(would import / already imported / refused + reason); `--yes` writes. Running against real Bunny needs user sign-off.

## Rulings (user, 2026-11-04, relayed by the website session)

1. No-licence rule confirmed: imported items have an empty `licenceName` and cannot be published until the photographer
   grants a licence; `credit` carries over; email is left out; the audit note is as above.
2. Import every D1 `status` except `rejected` (pending, changes_requested, approved). Rejected proposals stay in D1 and
   are deleted with it. The command refuses a manifest entry with status `rejected` (the manifest carries `status`).

## Open questions (user)

1. Description and rights-statement fields on media (decide first; payload `description`, `aircraft`, `location`,
   `rightsBasis` would map onto them). Then this plan goes through the plan gate and is built.
