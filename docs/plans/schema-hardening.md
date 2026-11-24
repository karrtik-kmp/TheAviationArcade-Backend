# Schema hardening wave (timestamps, append-only, history)

Status: **BUILT (local) 2026-11-24.** Approved by the user after the plan-review gate; built in slices S1-S7; independent code review fixes applied. Not applied to any hosted database (see Rollout). Evidence: `docs/TASKS.md` row 6.4.

Origin: the 2026-11-24 database review (an expert review of `src/db/schema.ts`, checked against the website, Admin
and Unity v2). The gate was senior-lead, backend-expert, game-domain-expert and devops-expert. All four said
"approve with changes", and every required change is folded in below. Each finding was checked in code.

## Goal

- Every mutable table says when it last changed and who changed it.
- Every table the docs call append-only actually refuses change.
- Two pieces of history that are lost today are kept: UGS re-links, and the first import of a content receipt.
- Incomplete CHECKs on completed Flight Segments and Rounds are closed.

There is no change to economy, award or rank rules: `src/rules/` is untouched (domain review). There is no API or
contract change, with two exceptions:
- The `content_import` audit `detail` gains `createdIds`.
- `ImportSummary.createdAt` now reports the last apply of a receipt, so the counts and the time describe the same
  run. It was already rewritten on every refresh.

## Not in this wave

- **Decisions the user still has to make:** a non-PII account-deletion receipt, refunds for purchase rows deleted
  with the account (P4), and where Callsign uniqueness lives. When P4 handles refunds, it must write compensating
  ledger rows and never delete; the new triggers enforce that.
- **Cross-repo gaps:** sent as briefs to the website and Unity sessions.
  - Website: migrating D1 `submissions`, `editorial_records` and `audit_events`.
  - Unity: the `/v1/plane-of-the-day` path, `/v1/bootstrap`, `/v1/callsigns/*`, `deviceId`, liveries and
    `contracts/products.v1.json`.
- **Feature work:** rewarded-ad hints, `rounds.mode` for Study Flights, and retention/pruning of ever-growing tables.
- **A shared Drizzle timestamps helper.** Rejected. The tables use different clocks on purpose, and
  `defaultNow()`/`$onUpdate` would add a third.
- **Applying 0027 to the hosted dev or prod database.** That is a separate step, needing the user's sign-off (see
  Rollout).

## Backfill policy

Where the true actor or time is unknown for pre-0027 rows, the migration writes the sentinel `system:pre-0027`
instead of a guess that would look like real data. Where an exact value can be derived (from `admin_audit` or the
rows themselves), it is used.

## Changes

One new migration, `0027_schema_hardening`. Drizzle generates the columns, indexes and the new table. The
backfills, triggers, `NOT VALID` CHECKs and the 3-step NOT NULL are hand-edited. Precedents: data backfill in 0003,
drop and re-add of a NOT VALID CHECK in 0026:1,9.

| # | Table | Change | Backfill for pre-0027 rows |
|---|---|---|---|
| C1 | `content_imports` | Add `last_applied_at` and `last_applied_by` (NOT NULL). The replay `ON CONFLICT` sets these and the counts, and stops rewriting `created_at`/`imported_by` ([content.service.ts:202](../../src/content/content.service.ts)). `latestImport` (:458), `replayableImport` (:447) and the stamp invariant in [content-lock.ts:21](../../src/content/content-lock.ts) move to `last_applied_at`. `ImportSummary.createdAt` maps to `last_applied_at`. | `= created_at, imported_by`, which is exact: today `created_at` already means "last applied". |
| C2 | `content_items` | Add `created_by` (NOT NULL) and `created_import_id` (nullable FK to `content_imports`), both set on insert. The `content_import` audit `detail` gains `createdIds` (:288). | Where `version = 1` (never updated, since every update bumps version): `created_by = updated_by` and `created_import_id = import_id`. Otherwise `system:pre-0027` and NULL. |
| C3 | `media_versions` | Add `updated_at` and `updated_by` (NOT NULL). Set on all three insert sites: [media.service.ts:641](../../src/content/media/media.service.ts), [media-import.ts:448](../../src/content/media/media-import.ts), [demo-seed.ts:661](../../src/content/demo-seed.ts). Also set on the two in-place draft edits (:429, :567). Publish stops updating a version that is already published (:488): when `draft.publishedAt` is set, the row is left as it is. | `updated_at` and `updated_by` describe one event: the latest of the version's `media_edit`/`media_rights` audit rows and its FIRST `media_publish` (target `'med-'||media_id`). `updated_at = GREATEST(created_at, published_at, rights_stated_at, that event's time)`. Without an audit event: `created_by`. |
| C4 | `account_roles` | Add `updated_at` (NOT NULL), set by every role-store write. `clearEmails` also sets it and bumps `revision` ([role-store.ts:605](../../src/accounts/role-store.ts)). | `GREATEST(requested_at, decided_at, latest role_* audit row whose target = principal and detail.role = role)` |
| C5 | `player_clipper_cards` | Add `last_identified_at` (NOT NULL), set to the Segment-completion `now` on both the insert and the update ([trip-completion.ts:247-253](../../src/trips/trip-completion.ts)). | `GREATEST(first_collected_at, MAX(trips.closed_at))` over rounds joined to trips, with `trips.status = 'completed'`, `rounds.status = 'completed'`, `rounds.finished` true, and matching player and `card_key` |
| C6 | `ugs_mirror_outbox` | Add `first_enqueued_at` (NOT NULL, "row created at"). It is in the INSERT column list of [mirror-outbox.ts:45](../../src/balance/mirror-outbox.ts) and kept out of the `ON CONFLICT … SET`. | The migration instant (a transient queue; documented) |
| C7 | `store_products` | Add `created_by` and `updated_by` (NOT NULL), set by the catalog service. `seedDemoCatalog` wraps its insert and a new `store_product_create` audit row (actor `operator:<os user>`) in one transaction. | Actor of the earliest and the latest audit row with `target = product_id AND action IN ('store_product_create', 'store_product_edit', 'store_product_retire', 'store_product_restore')`, ordered by `id`, else `system:pre-0027` |
| C8 | `rounds` | Add `abandoned_at` (nullable). `abandonOpenRounds(tx, principal, now)` sets `LEAST(now, expires_at)`, matching how `abandonTrip` closes at expiry. Callers: [rounds.service.ts:155](../../src/rounds/rounds.service.ts), [trips.service.ts:130](../../src/trips/trips.service.ts), [trip-store.ts:102](../../src/trips/trip-store.ts). New CHECK `rounds_abandoned_at_check`, NOT VALID: `(status = 'abandoned') = (abandoned_at IS NOT NULL)`. | NULL. NOT VALID exempts old rows, which are never updated again (domain review). |
| C9 | new `ugs_link_events` | Append-only: `id` identity, `player_id` FK → players ON DELETE CASCADE, `kind` (`linked` / `replaced` / `moved_away`), `ugs_player_id`, `previous_ugs_player_id` (nullable), `created_at`, index `(player_id, id)`. Written in the same transaction as the `ugs_links` change ([player-balance.ts:312-332](../../src/balance/player-balance.ts)): `moved_away` for the stale holder, then `linked` or `replaced` (with the previous id) for the caller. The same-id race path writes nothing, and `erase` writes nothing (rows cascade). Added to the PlayerBalance-only rules in `test/balance-guard.test.ts`. | None |
| C10 | `trips` (Flight Segments) | New CHECK `trips_completed_result_check`, NOT VALID. A completed segment has every result column set: `correct`, `hint_used`, `best_streak`, `miles`, `status_points`, `go_around`, `night_trip`, `completion_local_date`, `catalog_version`. `completeFullTrip` already writes them all (trip-completion.ts:276-290). | NOT VALID |
| C11 | `rounds` | New CHECK `rounds_completed_at_check`, NOT VALID: a completed Round has `completed_at` and `local_date`. The one bank path sets both (rounds.service.ts:330, 347). The existing, validated `rounds_completed_has_award_check` is not touched. | NOT VALID |
| C12 | `store_transactions`, `store_subscriptions` | Index on `product_id` | None |

### Append-only triggers (T1)

These follow the 0024 pattern: a BEFORE row trigger plus a BEFORE TRUNCATE statement trigger, raising
`restrict_violation`.

| Table | UPDATE | DELETE | TRUNCATE |
|---|---|---|---|
| `miles_ledger`, `hint_ledger`, `store_transactions`, `ugs_link_events` | refused | Only from the `players` cascade: `pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM players WHERE id = OLD.player_id)` | refused |
| `admin_audit` | refused | refused | refused |
| `media_versions` where `OLD.published_at IS NOT NULL` | refused (published rows are fully immutable once C3 changes publish) | refused (media is never deleted) | refused |

The migration test must prove the cascade test against Postgres 18.4:
- `erase` (player-balance.ts:289) passes.
- A direct `DELETE` is refused.
- `WITH d AS (DELETE FROM players …) DELETE FROM miles_ledger …` is refused.

The triggers guard against bugs only: the app's database role owns the tables and could disable them. This is
documented.

### Migration statement order

1. `SET LOCAL lock_timeout = '5s'`.
2. `DROP` `media_versions_publishable_check`. It is NOT VALID but enforced on UPDATE, so the C3 backfill would abort
   on pre-0019 published rows. `migration-0019.e2e.test.ts:105` proves the enforcement.
3. Add every column as nullable, then the new table.
4. Run the backfills.
5. `SET NOT NULL`.
6. Re-add `media_versions_publishable_check` NOT VALID, unchanged from 0026.
7. Add the new CHECKs, NOT VALID.
8. Add the indexes.
9. Create the triggers, last of all.

A comment states that the NOT VALID CHECKs must never be `VALIDATE`d while legacy rows remain.

## Slices (one owner per file)

S1 is written first. S2–S5 then run in parallel. S6 follows them; S7 runs alongside. The tree type-checks only
when every slice is done, so the wave is verified and committed as one unit (review-in-waves).

| Slice | Owns | Content |
|---|---|---|
| S1 schema | `src/db/schema.ts`, `src/db/enums.ts`, `drizzle/0027_*`, `drizzle/meta/*`, `test/schema-parity*.ts`, new `test/migration-0027.e2e.test.ts` | All columns, CHECKs, indexes, the table, the backfills and the triggers. The migration test seeds pre-0027 rows (including a pre-0019 published version) and proves each backfill, the NOT VALID exemptions, every trigger refusal and the cascade pass-through. |
| S2 content | `src/content/content.service.ts`, `src/content/content-lock.ts`, `src/content/content-item-edit.service.ts`, `src/content/demo-seed.ts` | C1, C2, plus the C3 insert in demo-seed |
| S3 media | `src/content/media/media.service.ts`, `src/content/media/media-import.ts` | C3 and the publish no-op on an already-published version |
| S4 accounts, balance, UGS, trips | `src/accounts/role-store.ts`, `src/balance/player-balance.ts`, `src/balance/mirror-outbox.ts`, `src/trips/trip-store.ts`, `src/trips/trip-completion.ts`, `src/trips/trips.service.ts`, `src/rounds/rounds.service.ts` | C4, C5, C6, C8, C9 |
| S5 store | `src/store/store-catalog.service.ts`, `src/store/seed-demo.ts` | C7 |
| S6 tests | new `test/frozen-cleanup.ts`, every affected test file | See below |
| S7 docs | `docs/ARCHITECTURE.md`, `docs/TASKS.md`, this file | Replace the stale clock paragraph (ARCHITECTURE.md:382-388) with one "Clocks" table. List the append-only tables and the owner caveat. Document the `content_items.card_key` system write. Add the 0027 deploy note (`--stop-first`). |

**S6 test inventory.** Generate it with grep; don't keep it by hand.
- **Cleanup helper.** `test/frozen-cleanup.ts` deletes inside one transaction, with `SET LOCAL lock_timeout` and
  `ALTER TABLE … DISABLE TRIGGER`, the pattern of military-releases.e2e:77. E2E runs with
  `fileParallelism: false`. It replaces about 40 cleanups:
  - `DELETE FROM admin_audit`
  - `DELETE FROM media_versions` (10 suites, including editorial-helpers:157)
  - `hint_ledger` (trips.e2e:899)
  - `store_transactions` (store-products.e2e:425)
- **Published-version UPDATEs** now meet the freeze trigger: military-releases.e2e:662/666 and
  dev-demo-waiver.e2e:130. media-schema.e2e:228 now expects the trigger's error, not the CHECK's.
- **Raw INSERT fixtures** missing the new NOT NULL columns:
  - helpers: store-helpers, roles-helpers, trip-helpers
  - suites: content-documents, content-publish, logbook, trips, media, media-rights, media-schema, roles,
    store-schema, ugs-pacing
  - migration-0018, 0019 and 0026 tests, which migrate to head and then insert
- **New e2e tests** for each of C1–C12. Content-items-edit.e2e:379 moves to `last_applied_at`.
- **Source-scan unit test:** forbids `DISABLE TRIGGER` and `session_replication_role` under `src/`.

## Verification

- `npm run typecheck`, the unit suite and the e2e suite, run from PowerShell (vitest needs the uppercase drive).
- The migration test on a database seeded with pre-0027 rows.
- `code-reviewer` over the whole diff. Then commit and push to `main`.

## Rollout (each step needs the user's sign-off; not part of the build)

1. **Read-only counts on dev** of rows that C8, C10 and C11 would reject. If there are none, a later migration
   may `VALIDATE`.
2. **Backup:** `pg_dump -Fc` of the dev database, to a folder outside `html/`. Nothing else backs Postgres up
   (server/README.md:226).
3. **Deploy:** `backend-deploy.sh --stop-first`. Without it, old code keeps serving between migrate and restart
   and fails inserts on the new NOT NULL columns (backend-deploy.sh:66-84). On dev this means a short outage; the
   build runs before the stop.
4. **Checks after deploy:**
   - `/v1/health/ready` and the pm2 logs
   - the triggers are present in `pg_trigger`
   - `convalidated = f` on the new CHECKs
   - a smoke test: sign up, complete a Flight Segment, abandon a Round
5. **Rollback:**
   - A failed migrate rolls back as a whole (one transaction). Redeploy the previous release zip.
   - After a successful migrate, an old build can't run. On dev, restore with `pg_restore` from step 2.
   - For prod, write and test a relax script (drop the triggers and the C8 CHECK, `DROP NOT NULL`) before the prod
     deploy.
6. **Manual cleanup** on a hosted database now needs `DISABLE TRIGGER`, which is a step needing sign-off.
