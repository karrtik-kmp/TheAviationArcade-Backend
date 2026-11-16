# Plan: Aircraft Identifier import (slice I3) and the dev demo seed (scenario E4)

Status: **approved with changes** (2026-11-16; senior-lead, backend-expert, game-domain-expert all "approve with changes";
every required change is in §G below, which overrides the sections above where they differ). Source: website brief
`../website/docs/briefs/backend-firebase-project-and-demo-seed.md` (website `56ae431`), intent
`../website/docs/intent/hosting-dev-demo.md`, ruling row 2026-11-16 in `../docs/PROJECT_STATE.md`. Part 1 of that brief (Firebase
project `airplane-games-9fe1e`) is done in `2315d8a`.

## 0. Findings that shape the plan (where the brief does not fit the code)

1. **The dev backend runs `APP_ENV=production`** (`../server/backend.env.example:6`; there are only `local | test | production`).
   "Refuse a production `APP_ENV`" taken literally would refuse the dev backend too. Proposal: with `APP_ENV=production` the seed
   runs only when the database name from `DATABASE_URL` ends in `_dev` (the server scripts name them `airplane_games_dev` /
   `airplane_games_prod`, `../server/README.md:70-77`). Anything else under production is refused before connecting.
2. **Plane of the Day is editorial, not a Module.** The website's Plane of the Day desk is `editorial_items` (W1,
   `docs/plans/website-content.md` §0.5): `MODULE_IDS` stays 8, so there is no xlsx module for it. `EditorialService.create`
   requires a **published** photo (`src/content/editorial/editorial.service.ts:211-226`), and the brief says the seed publishes
   nothing. So the seed uploads the 5 photos as drafts and creates each Plane of the Day draft **only once its photo is
   published** (by the user, in the Admin); until then the entry is listed as "waiting for med-N to be published", and a re-run
   creates the drafts. No rule is relaxed. (Alternative for the user: let a *draft* editorial item link an unpublished photo, publish
   still re-checks. Not done here: it changes the W1 desk contract the website relies on.) This supersedes W1's "the 5 client Plane
   of the Day entries are not seeded" (user ruling 2026-11-16: seed them as drafts).
3. **Aircraft Identifier questions go to `content_items`, module `identifier`** (slice I3, `docs/design/releases-and-dealing.md`
   row "identifier"): the dealable questions come only from the client sheet. The website's Identifier *desk* is editorial today;
   it will need to read `GET /v1/admin/content/identifier/items` to show them (message to the website session).
4. **Unity's ids are not sequential**: `ai-a1`…`ai-a31` minus `ai-a8`/`ai-a14`, plus `ai-a11-2` and `ai-a18-2` (the second
   question on a shared photo, `Tools/ContentImport/import_client_content.py:199-203`). The client-sheet planner numbers new rows
   `formatId(max + 1)` and matches by a natural key that must be unique, and `file` is not unique here (two rows each for
   `ai-a11.jpg` and `ai-a18.jpg`). So the planner gains a mapping flag (S1).
5. **Unity leaves rows out** (`validation_problem`, same file `:163-173`): an empty answer cell, the correct answer repeated as a
   wrong one, or two equal wrong answers (casefold). The Military mapping makes those a 422 for the whole file. To hold the same 31
   questions, the Identifier mapping leaves such rows out with a warning instead (ASSUMPTION test), as Unity reports them.
6. **No photographer grant exists**: `roles:grant` and `RoleStore.grantAdmin` grant admin only; photographer is request + approve.
   The brief asks for an operator grant of photographer by uid through the same audited store (S3).
7. **The seed cannot prove a uid exists in Firebase**: the backend holds no Admin credentials by design, and a website-only sign-up
   leaves no backend row (`GET /v1/me/roles` writes nothing). "Not in `airplane-games-9fe1e`" is therefore enforced as: the
   configured project must be a real one (not `demo-`), a bare uid is bound to it, a full principal of any other project is refused,
   and a uid the backend has never seen (no `players` or `account_roles` row) is a WARNING the operator reads before `--yes`.
8. **The files live on the user's PC**, not the server. The seed takes both folders as required arguments, never a default path.

## S1. Planner: ids that come from the sheet (`src/content/content-module.ts`, `src/content/import-plan.ts`)

- `ContentModuleMapping.keyIsId?: true`: the parser derives each client-sheet row's identity from the sheet and puts it in
  `ParsedRow.naturalKey`; the planner then matches a stored item by its **id** (not `naturalKey(data)`), and a created row takes
  that key as its id (it must satisfy `idNumber(key) !== undefined`, else a row error). Blank or repeated keys stay row errors.
  Unmatched approved items are retired as today. `requiresConfirm`, `planHash` and the counts are unchanged.
- Admin export with `keyIsId`: the Id column is the identity as today; the "file name unique module-wide" check uses ids (so it
  never fires), and a new id needs only the id shape (no sequence ceiling: ids are not a dense sequence).
- Military and Airport Spotter don't set the flag: their behaviour and plan hashes are byte-identical (existing tests prove it).

## S2. Mapping `identifier` (`src/content/modules/aircraft-identifier.ts`, registered in `content-modules.ts`)

- Sheet "Airplane Identifier v1.xlsx": header found in the first 10 rows with Level, Correct Answer, Wrong Answer 1-3, file (no
  photographer column). Extra columns (folder, H/V, Resolution) ignored. Rows with neither an answer nor a file are skipped (Level
  only: placeholder warning).
- Unity's two logged fix kinds only, each a warning `Corrected on import: …` naming the row: `\bBoing\b` → `Boeing` in the four
  answer labels; a file name `<stem>/<jpg|jpeg|png>` (or `\`) → `<stem>.<ext lower-case>`. Nothing else is rewritten.
- Rows Unity leaves out (finding 5) are skipped with a warning `Left out: <reason>. Answers: …` (row 11 `ai-a8`, row 18
  `ai-a14`). They take no id.
- Id = the corrected file stem (must match `ai-a<N>`), plus `-<k>` for the k-th kept row on the same photo, in sheet order
  (`ai-a11`, `ai-a11-2`). Pattern `^ai-a[1-9]\d{0,5}(-[2-9]|-[1-9]\d{1,2})?$`. A stem of any other shape is a row error.
- Payload `{ answer, wrong[3], sourceFile }` (as Airport Spotter: no photographer column, credit lives on the photo), validated
  by the shared `validatePayload` (four distinct answers after trim + whitespace collapse + lower-case). The Level maps through
  `rankFromDisplayName`. No Card key is stored (the commercial Card family source is still open, design row "identifier").
- Export: Id, Version, Level, Correct Answer, Wrong Answer 1-3, file, Status (+ the service's Media Id column).
- `DEAL_POLICY.identifier` already exists, so `trip-coverage` starts answering for `identifier`.
- Tests: fixtures for every rule; the real file (skip if absent): 31 rows, the 5 fixes, the 2 exclusions, the ids; and a
  cross-check against Unity `identifier_questions.json` (skip if absent): same ids, ranks, answers and wrong answers in order.
- `docs/openapi.yaml`: the import, items and coverage routes list `identifier`; API 0.26.0 → 0.27.0 (a module becomes
  importable). `contracts/` regenerated if it changes.

## S3. Operator photographer grant (`src/accounts/role-store.ts`)

`RoleStore.grantPhotographer(actor: operator, principal, note)` under the role lock: no row → `active`; `pending`, `rejected`,
`revoked` → `active` (revision + 1, decision fields set, `requestEmail` kept); `active` → no-op (`changed: false`, no audit);
`blocked` → 409, nothing written; the demo principal → refused before any read. One `role_grant` audit row per change, actor
`operator:<os user>`. Operator-only (an API admin keeps using approve). ADR-0002 note: a user-ruled operator path, like
`roles:grant`.

## S4. The seed (`src/content/demo-seed.ts` core, `scripts/demo-seed-content.mjs`, `npm run demo:seed-content`)

```
npm run demo:seed-content -- --docs <root docs dir> --delivery <2026-09-28 folder> --owner <staff photographer uid>
                             [--photographer <uid>]... [--photographers <file>] [--yes]
```

**Refusals before connecting (exit 2, pure `seedRefusal`, unit-tested):** unknown or missing arguments; a `demo-` project;
`APP_ENV=production` with a database name not ending `_dev`; `--yes` without `BLOB_STORE=bunny` (as `media:import`); an owner or
photographer that is not a valid uid, is a full principal of another project, or is the demo account.

**Sources, read-only:** `<docs>/Military Airplane Identifier v1.xlsx` + the single `Military Airplane Identifier - Pictures*`
folder (its one inner folder); `<delivery>/Airplane Identifier v1.xlsx` + `Airplane Identifier-*/Airplane Identifier/`;
`<delivery>/Airplane Games - Game Play.xlsx` + `Plane of the Day-*/Plane of the Day/`. Files are read with
`readRegularFile` (no symlinks, size caps). The Plane of the Day sheet is parsed by a small pure reader (header row "Image #";
Title, Manufacturer, Model, Description, Photographer, Instagram), values as written.

**Order and write paths (no second way of writing anything):**
1. **Roles:** each listed photographer → `grantPhotographer`. Dry run: current state → "would grant" / "already active" /
   "refused (blocked)".
2. **Content (Military, then Identifier):** `ContentService.dryRun`. Replay or a plan of only `unchanged` rows → "unchanged",
   nothing applied (so a re-run writes no receipt). Creates only → `apply`. Any update or retirement → that module is **refused**
   with the diff listed: the seed never confirms an overwrite of stored content; the user does that in the Admin import.
3. **Photos:** one media item per photo file, `MediaService.create(owner, key, bytes, type, false, "v1_authorised")` with key
   `demo-seed-<mil|ai|potd>-<stem>` (hashed when the stem is outside `[A-Za-z0-9_-]`), so a re-run replays. Draft only:
   `unverified`, never published. Matching a row to a file: exact, then case-insensitive, then the same stem with an image extension
   when unique (Unity's three Military matches: no extension ×2, `.jpog`), each non-exact match reported. `mil-a5` (C-17) has no file:
   reported, no replacement.
4. **Licence fields**, only while the draft's credit and licence name are both empty (else left alone, a difference is
   reported): Military credit = the sheet's Photographer, licence name "Unsplash License" (Josh, WC-3); a row with no photographer
   gets no credit and is reported (cannot be published until one is set). Identifier and Plane of the Day: credit
   "Josh M (@iamjoshmark)" (Unity ruling 2026-09-29, client unconfirmed), **no licence name** (the user is asked before
   publishing). Through `MediaService.edit` as the owner.
5. **Links:** an item with no `mediaId` → `ContentItemEditService.setMedia` to its photo; an item linked to another photo is
   left and reported.
6. **Plane of the Day drafts** (finding 2): an entry whose photo is published and has no `plane-of-the-day` item yet →
   `EditorialService.create` with data: title, aircraft = Manufacturer + " " + Model, photographer, instagram (URL), credit =
   `@<handle>`, description, every other field empty. Not published → "waiting". Already there → "unchanged".

Writes outside media run as `operator:<os user>` (as `roles:grant`). Output: one line per role, item, photo, link and entry,
then counts; exit codes as `media:import` (0 / 1 / 2 / 3 / 4). Never prints the database password or a key.

**Re-run:** every step above is idempotent by construction, so a second `--yes` writes nothing (e2e: no new audit, receipt,
media or editorial row).

## Tests

- Unit: S1 planner cases; S2 mapping (fixtures, real file, Unity cross-check); `seedRefusal` (production + non-`_dev` database,
  `demo-` project, demo account, another project's principal, `--yes` without Bunny); photo matching; Plane of the Day reader.
- E2E (`airplane_games_test`, memory blob store, a config with a non-demo project): `grantPhotographer` transitions; the seed
  core on small synthetic folders (tiny PNGs) and, when present, the real files: dry run writes nothing; apply; second apply
  changes nothing; a staff edit then makes the next run refuse that module; Plane of the Day waits, then (photo published in the
  test) the next run creates the drafts once.
- CLI spawn tests for the refusals (production with `airplane_games_prod`, `demo-` project), from a temp cwd.

## Not in scope

Publishing anything; the full 241-row Google Sheet; a Card family source; editorial Identifier items; Unity or website changes
(messages only); running against any hosted database.

## G. Plan-gate changes (binding; override S1-S4 where they differ)

**Roles (S3).** `grantPhotographer` grants only from **no row** or **`pending`**. `rejected`, `revoked` and `blocked` are refused
("an admin decided this; decide again in the Admin"), so a re-run never overturns a staff decision. ADR-0002 gets a dated
"Follow-up ruling (user, 2026-11-16)" section citing `../website/docs/intent/hosting-dev-demo.md`.

**Photos (S4.3-S4.4): an operator writer, not `MediaService.create`.** Like the D1 import (`media-import.ts:349-499`): blob via
`MediaService.checkImage` (size, 4096 px, sniffed type, never the extension) + `storeImage`; then one transaction per photo that
re-checks the owner (active photographer or admin row, FOR SHARE; never the demo principal), inserts the item (`owner` = the staff
photographer, `created_by`/`updated_by` = `operator:<os user>`, state `unverified`) and version 1 (`rights_statement`
`v1_authorised`, `rights_stated_by` = `operator:<os user>`: the operator states the client's licence, not the photographer;
credit and licence name set **at insert**, never edited later), claims `media_imports` (`source_system` `demo-seed`, new
migration widening the CHECK; `source_id` `<mil|ai|potd>/<file name>`, ≤ 128), and writes `media_import` audit with `source:
"demo-seed"`. A claim with the same owner and sha256 = "already uploaded"; any other = refused (conflict), nothing changed. So a
changed `--owner` is refused, not duplicated, and a credit staff cleared is never refilled. Every photo file is uploaded,
including `ai-a8.jpg` and `ai-a14.jpg`, which are reported as "no question (row left out)". `--yes` also refuses an unset
`DEMO_ACCOUNT_UID` (the demo refusal must mean something).

**Licences.** Military: the row's Photographer + "Unsplash License" (WC-3). Identifier and Plane of the Day: credit from the row
(Identifier: Unity's ruling "Josh M (@iamjoshmark)"; Plane of the Day: that row's Photographer + `(@handle)` from its Instagram),
**no licence name**: the 11-16 brief governs over WC-3's "Unsplash License" for the Identifier (WC-3 superseded there; user
question). Consequence reported: Plane of the Day drafts wait for published photos, which wait for a licence.

**Links (S4.5).** Only when the item has no `media_id` AND no `content_media_link` audit row exists for it (staff never
linked or cleared one). A module refused at step 2 skips its photo-link steps (its photos still upload: they are files, not
content).

**Content (S4.2).** `apply` gets `confirm = planHash` of the dry run (`assertConfirmed` checks it even for a creates-only plan).

**Run lock.** The whole `--yes` run holds a session `pg_try_advisory_lock` on a dedicated connection; a second run is refused.
Plane of the Day "already there" = any `plane-of-the-day` row with that `media_id`, archived included (a staff-made one too).

**Database refusal.** Refuse a `DATABASE_URL` naming no database; refuse a name ending `_prod` under any `APP_ENV`; under
`production` only a name ending `_dev`. Print the target (host, port, database, APP_ENV, project, blob store) first.

**S1/S2 details.** In `keyIsId` mode every `mapping.naturalKey(stored.data)` in the planner becomes `stored.id`
(`import-plan.ts:117,170,194,259`); `PlanOptions.mapping` includes `keyIsId`; for Identifier `naturalKey(data)` returns
`sourceFile` (display only) and the `content-module.ts:57` doc says it differs from `ParsedRow.naturalKey` in this mode. Order per
row, as Unity: file fix, then label fixes, then Unity's leave-out predicate (casefold) BEFORE `validatePayload`; a row Unity keeps
but `validatePayload` refuses is a row error, never dropped. ASSUMPTION tests: an earlier excluded row being fixed renumbers later
`-k` ids (shows as update/retire; the seed refuses); `ai-a11` and `ai-a11-2` link the same media item; editing `ai-a11` does not
422 against `ai-a11-2`; release routes still refuse `identifier`.

**Plane of the Day reader.** Numbers read as written (`737`, not `737.0`); `aircraft` = the non-empty trimmed Manufacturer and
Model joined by a space; `factualSource` left empty and reported per entry (publish needs an https one; never the Instagram link).

**Running it on dev (user sign-off step, not done here).** The files are on the user's PC and the dev Postgres listens on the
server's 127.0.0.1 with `verify-full`. Either copy the two folders to the server (read-only) and run there as the app user with the
dev env file, or an SSH tunnel from the PC with the CA and hostname. README documents both; the run itself waits for the user.

**Open for later (not this wave), user/client questions:** licence of the Identifier and Plane of the Day photos; a factual
source per Plane of the Day entry; two questions on one photo cannot share a release (`content_release_items_photo`), a
prerequisite for M-ID; `releaseCardKey` is Military-only; the full sheet's D5 "blocked, not left out" direction.
