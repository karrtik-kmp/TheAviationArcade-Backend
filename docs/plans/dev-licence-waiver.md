# Plan: dev-demo waiver: no photo licence and no Plane of the Day factual source, on the dev database only

Status: **approved with changes** (2026-11-16; senior-lead and backend-expert, both "approve with changes"; §G below is
binding and overrides everything above it, including the variable name). Ruling: user, 2026-11-16, relayed by the website session: "Every image is
already there for now you can skip licenses like unsplash or client side. there are two folders for now." Scope: the dev demo
(`docs/plans/demo-seed.md`, scenario E4). Production publishing rules stay exactly as they are.

## Where the licence rule lives today

- `MediaService.publish` refuses a draft with no `licence_name` (`src/content/media/media.service.ts:472-474`).
- The database refuses it too: `media_versions_publishable_check` (`src/db/schema.ts:438-441`, added NOT VALID by hand in
  migration 0019) requires `licence_name IS NOT NULL` once `published_at` is set.
- Nothing else reads `licence_name` for a decision (grep: only the view, the edit and the importers).

Credit and the rights statement are NOT part of this ruling and stay required: `creditRequired` + `credit_name`, and a `v1_*`
statement (the seed's photos carry `v1_authorised`). The 4 Military photos without a photographer in the client's sheet still
cannot be published until an admin sets a credit or turns `creditRequired` off (admin-only, existing route).

## Change (narrowest that works)

1. **Config `MEDIA_LICENCE_WAIVER`** (optional; the only value is `dev-demo`). `loadConfig` refuses to start with it set unless
   the database name in `DATABASE_URL` ends `_dev` (the server's dev instance, `airplane_games_dev`), or `APP_ENV=test` (the
   suite). Any other value, a nameless database, or a name ending `_prod` fails at startup naming the variable only. So the prod
   instance can never run with it, whatever `APP_ENV` says.
2. **Column `media_versions.licence_waiver`** (text, nullable, CHECK `IN ('dev-demo')`). New migration 0026: add the column, then
   drop and re-add `media_versions_publishable_check` NOT VALID by hand (as 0019 did) with `licence_name IS NOT NULL` replaced by
   `(licence_name IS NOT NULL OR licence_waiver IS NOT NULL)`; every other term unchanged. Plus a CHECK that a waiver only sits on a
   version with no licence name (`licence_waiver IS NULL OR licence_name IS NULL`), so a record never claims both.
3. **Publish.** When the draft has no licence name and the config has the waiver, `publish` stamps `licence_waiver = 'dev-demo'`
   on the version it publishes (same UPDATE as `published_at`), and the `media_publish` audit detail gets `licenceWaived:
   "dev-demo"`. Without the config the 422 is unchanged. A draft with a licence name never gets a waiver.
4. **Records stay honest.** `licence_name` stays NULL: the record says "no licence", plus the waiver that let it go live. A later
   licence edit makes a new draft version (existing rule: the published version is never edited), which carries no waiver; its
   publish then needs a real licence or the waiver again.
5. **Staff view.** `MediaVersionView` (and the staff item view's licence block) gains `licenceWaiver: "dev-demo" | null`, so the
   Admin can show "published without a licence (dev demo)". The public `ImageRef` is unchanged (no licence fields there today
   beyond the credit). `docs/openapi.yaml` 0.27.0 → 0.28.0; `contracts/` regenerated if it changes.
6. **Seed.** `demo:seed-content` stops writing "Unsplash License" on the Military photos (the ruling skips Unsplash too): every
   seeded photo has `licence_name` NULL. Not yet run anywhere hosted, so no data to correct.

## Putting the rule back (when Josh answers)

(Updated to the final design, §G.) Remove `DEV_DEMO_WAIVER` from the dev env file and restart: every new publish needs a
licence again, and every new Plane of the Day schedule or publish an https source. Photos already live keep their record
(`licence_waiver = 'dev-demo'`, no licence name). No API field carries the waiver (§G.2): staff find them with
`SELECT media_id, version FROM media_versions WHERE licence_waiver IS NOT NULL` or in the audit (`media_publish.licenceWaived`),
set the licence (new draft version) and publish it, or withdraw them. Credit-waived seed photos keep `credit_required = false`
(audit `media_import.creditWaived`). README "Dev-demo waiver" documents this; §G.7 has the full list.

## Still open (not covered by the ruling)

Nothing left from the original list: the Plane of the Day factual source is covered by the Addendum, and the 4 Military photos
without a credit by §G.9.

## Tests

- Unit: `loadConfig` accepts the waiver for `airplane_games_dev` (production) and `APP_ENV=test`; refuses it for
  `airplane_games_prod`, `airplane_games` (no `_dev`), a nameless URL, `APP_ENV=local` on a non-`_dev` database, any other value.
- E2E: with the waiver, an admin publishes a seed-style photo with no licence: 200, the version has `licence_name` NULL and
  `licence_waiver` `dev-demo`, the audit says so, the staff view shows it; without the waiver the same publish is 422 and writes
  nothing; a draft with a licence name publishes with no waiver; the DB CHECK refuses a waiver next to a licence name and a
  publish with neither (direct SQL); a Plane of the Day draft can then be created from the waived photo (seed run), and its
  publish is still refused for the missing factual source; schema parity updated.

## Not in scope

Any change to production behaviour; skipping the factual source or the credit; the website's display of the waiver (message to
the website session); the dev server's env file (the user sets `MEDIA_LICENCE_WAIVER=dev-demo` there; message for the
`server/backend.env.example` owner).

## Addendum (user ruling 2026-11-16, follow-up): the factual source too, same switch

The user's answer to "Skip the https source for the 5 Plane of the Day entries on dev too?": "Skip it on dev". It is folded
into the same change: **one config switch, one guard.** The variable is renamed to cover both:

- **`DEV_DEMO_WAIVER=dev-demo`** replaces `MEDIA_LICENCE_WAIVER` above (same startup guard: database name ends `_dev`, or
  `APP_ENV=test`; anything else refuses to start).
- **Plane of the Day publish/schedule.** With the switch on, `publishErrors` (`src/content/editorial/editorial-rules.ts:148`)
  skips the https factual-source rule for kind `plane-of-the-day` **only when `factualSource` is empty** (a non-empty value that
  is not https is still refused: a wrong source is not "no source"). Every other rule stays (title, 15-character description,
  date, published photo with a credit). The Aircraft Identifier editorial kind is not covered.
- **Record.** `factualSource` stays `""`: the item says "no source"; nothing is invented. The `editorial_save` audit detail gets
  `factualSourceWaived: "dev-demo"` when a save to `scheduled`/`published` relied on it. No new column: staff find such items as
  published/scheduled Plane of the Day rows with an empty `factualSource`.
- **Restoring the rule:** remove the switch; new schedules/publishes need an https source again; items already live keep their
  record and are found as above.
- **Tests:** with the switch, a Plane of the Day item with an empty source schedules and publishes (audit flag set); a non-https
  source is still 422; the Identifier kind still needs a source; without the switch the empty source is 422 as today.

## G. Plan-gate changes (binding)

1. **One switch: `DEV_DEMO_WAIVER=dev-demo`** (the name `MEDIA_LICENCE_WAIVER` above is void). Parsed like the other optional
   settings (empty = unset; any other value refuses startup). The guard is ONE shared helper used by the config loader and by
   the seed's `seedRefusal` (`src/content/demo-seed.ts:86-90`). It reads the database name with `pg-connection-string`, like
   `config.module.ts:151-158`. It refuses:
   - a URL that names no database;
   - a name ending `_prod`, checked first and under every `APP_ENV`;
   - anything else unless the name ends `_dev`, or `APP_ENV=test` with a `demo-` Firebase project (the pattern of
     `config.module.ts:314,391`).
   A loud warning is logged at startup while it is on. The error names the variable only.
2. **No API field and no contract change** (the website parses `MediaVersion`/`MediaLicence` with `.strict()` and the contract
   says `additionalProperties: false`, `openapi.yaml:6329-6343,6385`). The waiver is recorded in the database column
   `media_versions.licence_waiver` and in the audit details: `media_publish.detail.licenceWaived = "dev-demo"` and
   `editorial_save.detail.factualSourceWaived = "dev-demo"`. Staff see both in the audit desk (W4).
   `docs/openapi.yaml` 0.27.0 → 0.27.1 changes descriptions only, at `:3390`, `:6335` and the Plane of the Day publish rules:
   - with the dev-demo switch, a published version (and so a public `ImageRef` and Plane of the Day feature) may have
     `licenceName: null`;
   - a Plane of the Day item may go live with an empty `factualSource`.
   The website and Unity are told by message. The Admin's own pre-checks (`website/lib/media-form.ts:278`,
   `website/lib/rules.ts:172`) need a dev-only switch on the website side; that is the website session's to build.
3. **Keep "Unsplash License" on the Military photos** (client-supplied, WC-3): step 6 is dropped, and the seed is unchanged. The
   waiver only matters where no licence name exists (Identifier, Plane of the Day). Asked back to the user via the website
   session, with "keep" as the default.
4. **Migration 0026:**
   - add the column `licence_waiver`, with a CHECK `IN (...)` sourced from `MEDIA_LICENCE_WAIVERS` in `src/db/enums.ts`
     (listed in `EXPECTED_ENUM_CHECKS`);
   - add a CHECK `licence_waiver IS NULL OR (licence_name IS NULL AND published_at IS NOT NULL)`, which validates normally;
   - drop and re-add `media_versions_publishable_check` **NOT VALID by hand**, with a comment as in 0019:27-31, changing only the
     licence term to `(licence_name IS NOT NULL OR licence_waiver IS NOT NULL)`.
   The migration runs on prod too: prod's database then accepts "licence or waiver", and only the startup guard keeps waived rows
   off prod. README: never copy dev media rows into prod.
   Migration e2e test, modelled on `migration-0019.e2e.test.ts:86-108`: the constraint is still not validated, older published
   rows survive, and direct SQL with neither a licence nor a waiver is refused.
5. **Publish:** the waiver is stamped only when the draft has no licence name and the switch is on. A draft with a licence name
   never gets one. Withdraw and republish keep the version's waiver and its first `published_at`. With the switch off, a
   republish is 422 and nothing is written. Editing a waived published version creates a new draft with `licence_waiver` NULL.
6. **Plane of the Day:** `publishErrors(kind, status, data, dateKey, { waiveEmptyFactualSource })` stays pure, and
   `EditorialService` passes the flag from its injected config. "Empty" means `""` after the existing trim. A non-empty source
   that is not https is still refused, and the Identifier kind is never waived. The audit flag goes on every accepted
   Plane of the Day save to scheduled/published that has an empty source while the switch is on, re-saves included.
7. **Restoring the rule (README):**
   - new publishes and schedules need a licence or a source again;
   - items already live, or scheduled with a future date, keep being served, because the public read does not re-check them;
   - a re-save of such an item while it stays live is 422 until a source is added;
   - waived photos are found with `licence_waiver IS NOT NULL` or in the audit.
8. **Tests:**
   - config: `_dev` with production allowed; `_prod` refused under every `APP_ENV`, test included; a non-`_dev` name refused; a
     nameless URL refused; `APP_ENV=test` with a non-demo project refused; an empty value is unset; another value refused;
   - publish, withdraw/republish, switch off, edit after waiver and licensed draft, all as in point 5;
   - Plane of the Day: an empty source passes and gets the audit flag; a non-https source is refused; the Identifier kind is
     still refused; with the switch off it is 422;
   - the migration test from point 4;
   - schema parity;
   - commands: typecheck, `npm test`, the full e2e suite, and `contracts:write` with a diff (expected: no change).
9. **No credit on dev (user ruling 2026-11-16, "No credit on dev")**, seed only, same switch, no new rule. When the demo seed loads a
   Military photo that a question uses and the client's sheet gives no photographer, and `DEV_DEMO_WAIVER=dev-demo`, version 1 is
   inserted with `credit_required = false` (existing column) and no `credit_name` (never a made-up name); the photo's `media_import`
   audit detail gets `creditWaived: "dev-demo"`, and the report says "no credit in the client's sheet; credit not required
   (dev-demo waiver)". Without the switch the photo stays `credit_required = true` with today's note. A photo no question uses, and
   every Identifier and Plane of the Day photo, is unchanged. The four real photos (sheet rows 17, 26, 28, 29) then publish through
   `MediaService.publish` (they carry "Unsplash License").
