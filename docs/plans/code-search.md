# Plan: Code Search on the server (slice M-CS, design step 7)

Status: **approved with changes** (2026-11-25; senior-lead, backend-expert, game-domain-expert all "approve with changes"; every required change is in §G, which overrides the sections above where they differ). Source: the brief from the Unity/coordination session of 2026-11-25; design
[releases-and-dealing.md](../design/releases-and-dealing.md) rows `code-search`, `grid`, `grid-draw.v1`, `contracts/grid.v1.json`.
Client rulings: ladder and "every answer is a 3-letter IATA code, no ICAO tier" (email 2026-11-19); master pack 2026-11-17.
Unity commit `c18a93c` (branch `feat/monetization`) compiled the pack: `Assets/_Project/Resources/ClientContent/Arcade/code_search_master.json`
(schemaVersion 2, 3,740 boards, 10 dropped because placed letters spell a code twice). Unity and the pack are read-only here.

## 0. Findings that shape the plan

1. **There is no `/v1/sessions` here.** Unity's `HttpGameSessionService` (`POST /v1/sessions`, `codeSearchBoards` at the response
   root) talks to the retired Cloudflare Worker; Unity's own `INTEGRATION_SCENARIOS.md` Q-A says it is deleted in U7. This backend's
   session is the Trip: `POST /v1/trips`. So the boards ride on the Trip open response, at its root (`{ trip, progress,
   codeSearchBoards }`), each board in exactly Unity's `CodeSearchBoardWire` shape. Unity's future `/v1/trips` client reuses its
   `DecodeCodeSearch` board loop. Listed as a Unity change.
2. **Server dealing (R4) does not exist for any module.** Trips are client mode; releases are recorded, never delivered (W3). This
   slice deals Code Search only, at Trip open, **from approved `content_items`** (not from a release): releases cannot deliver
   anything yet, and the brief is "the dev environment can deal it from the database". The deck is stored on the Trip, so later
   edits, retires or re-imports never change a Trip in flight (design §4.2's rule), and an Idempotency replay returns the same deck.
   When releases deliver (R3/R4), the pool source moves from items to release rows; the stored deck and wire stay.
3. **R-1 conflict (flagged, not resolved).** Ruling R-1 (user, 2026-11-03) reveals one Flight at a time on `POST /v1/rounds`. The
   brief and Unity's decoder want all ten boards at open. A Code Search board *is* its answer (the targets), so sending ten at open
   reveals ten answers. Implemented as the brief says; since the deck is stored server-side, moving each board to its
   `IssuedRound` later is a wire change only. **Question for the user** (§9).
4. **The wire needs fields the pack does not hold verbatim:** `cells[]` (derived from `row`, `column`, `direction` and the code
   length, as `CodeSearchContent.StoredBoard.ToFlight`), `cityClue` (the pack's `city`), `clueMode` (`Code` none / `City` all /
   `Mixed`, as `CodeSearchFlight`), `width`/`height` (the rung's side), `durationSeconds` (the rung's clock; Unity's
   `CodeSearchFlight` refuses 0, so it must be sent even though design §4.2 said timers are not sent: the client ruled clocks on
   2026-11-19).
5. **`validatePayload(data)` has no rank**, and the staff edit route may change rank alone. So the payload rules split:
   rank-free rules in `validatePayload` (letters a square of A-Z, side 1..8, target shapes, the puzzle rules with all eight
   directions), rank-fit rules (side, target count, city count, directions of the rung) as import row errors and as a filter
   when the pool is built (a misfit is not dealt and is counted out by coverage, like a malformed Military row).
6. **Rounds stay v1 facts.** A dealt Code Search Round still reports `finished` / `errorCount` / `attempts`; the grid answer
   check (design §4.3 `selections`) is not in this slice.

## 1. Rules (pure, `src/rules/`)

- `word-grid.ts`: port of `GridDirection` (names and deltas in Unity's enum order), `GridDirections.TryResolve`, `Line`,
  `WordGridPuzzle.FindOccurrences` (a line and its mirror count once) and `WordGridPuzzleValidator.Validate(puzzle,
  allowedDirections?)` returning **the same messages** in the same order. Inputs normalised as Unity's constructors do (code
  trim + upper, clue trim, letters upper) so the port judges what Unity would judge; the importer additionally requires the
  stored form to be canonical already (no silent rewrite). Clue uniqueness case-insensitive per UTF-16 unit (`OrdinalIgnoreCase`).
  Test names follow `WordGridPuzzleValidatorTests` (one `it` per Unity `[Test]`).
- `code-search-ladder.ts`: `CODE_SEARCH_LADDER: Record<Rank, { gridSide, targetCount, cityClues, durationSeconds, directions }>`
  = the table in the brief (Trainee 6/4/0/60 E,S; First Officer 7/6/2/75 E,SE,S,SW; Captain 8/7/4/90 all; Check Airman 8/7/7/90
  all; Chief Pilot 8/8/8/75 all), `MAX_GRID_SIDE = 8`, and `checkRankTable(ranks)` (port of `CodeSearchContent.CheckRankTable`).
  Tests follow `CodeSearchLadderTests`.
- `grid-draw.ts`, rule id **`grid-draw.v1`**: pool in natural id order → the rank's boards only → partial Fisher-Yates
  `for i in 0..9: j = i + next(n - i); swap(i, j)` on `DeckRandom(fnv1a(seed))` (the shared dealer RNG; `next` becomes callable).
  Same loop as Unity's `CodeSearchContent.Deal`, with `System.Random` replaced (not ported). Fewer than ten boards at the rank →
  empty (cannot deal). `gridCoverage(pool)` = min(10, boards at each rank). Pure, no I/O.
- `dealer.ts`: `DealPolicy` gains `"grid-draw.v1"`; `DEAL_POLICY["code-search"] = "grid-draw.v1"`. `dealTrip` / `tripCoverage` /
  `dealTripWithPolicy` stay choice-only and throw `DealNotSupportedError` for a grid policy (the grid path is separate); a test
  pins that. `contracts/dealer.v1.json` `modulePolicy` gains the entry (regenerated).
- `grid-fixture.ts` → **`contracts/grid.v1.json`** (`npm run contracts:write`): format id, the ladder, `FNV-1a + xorshift32`
  recipe, a small synthetic pool (ids in natural order, all five ranks, >= 10 at one rank and < 10 at another) and cases
  `{ rank, seed, boardIds }` generated by `drawGridBoards` (never hand-written), plus coverage. `contracts/README.md` updated.

## 2. Content module `code-search` (`src/content/modules/code-search.ts`, registered in `content-modules.ts`)

- One item = one board. Id = the pack's id, `^CS-(TR|FO|CA|CH|CP)-\d{4}$` (`keyIsId`; `idNumber` = the 4 digits, `formatId`
  unused for creates). Rank = the `Level` column through `rankFromDisplayName` ("First Officer", ...); the id's prefix must match
  the rank (row error), so a board cannot silently move rank on import.
- Payload `{ letters: string, targets: [{ airportId, code, clue, city, row, column, direction }] }`: the pack record minus id and
  rank, keys in that order. `naturalKey` = id (display only).
- Sheet (client sheet): header `Game ID | Level | Letters | Targets`; Targets is the JSON array as written in the pack (one cell,
  well under the 32,767-char cell limit). Admin export / import: `Id | Version | Level | Letters | Targets | Status`. Row errors:
  bad JSON, unknown keys, wrong types, every `validatePayload` problem, rank misfit (§0.5), id/rank prefix mismatch. Header
  found in the first 10 rows. 3,740 rows < `MAX_ROWS` 5,000; 4 or 6 columns < 50.
- `src/content/grid-boards.ts`: `rowToGridBoard(row)` → a validated, rank-fit board in wire form (`cells`, `cityClue`, `clueMode`,
  `width`/`height`, `durationSeconds`) or undefined; memoised per (id, version) so a Trip open does not re-validate 750 boards.
- `ContentService.tripCoverage`: branches on the policy; for `grid-draw.v1` it builds the pool with `rowToGridBoard` and answers
  `gridCoverage`. Trip-coverage route then serves `code-search` (policy `grid-draw.v1`). Release routes keep refusing it.
- Tests: fixtures for every rule; the real pack when present (skip if absent): all 3,740 boards validate against their rung
  through the port (the "sample" is the whole pack: ~2 s), per-rank counts 748/742/750/750/750, the 10 dropped ids absent; a
  hand-broken copy of a real board fails with Unity's message; the client CSV is not read.

## 3. Trip open deals Code Search (migration 0030)

- `trips.deck_format` text NULL (`grid.v1` only, TS list `DECK_FORMATS`) and `trips.deck` jsonb NULL; CHECK both NULL or both
  set. Generated (`db:generate`, second run reports no changes); schema-parity list updated. No release column (none exists yet).
- `TripsService.openTrip`, for `module = code-search` only, inside the existing transaction after the player lock (no network):
  read approved `code-search` rows **at the Trip's rank** (`trips.rank`, Active Rank; SQL filter), natural id order →
  `rowToGridBoard` → `drawGridBoards(pool, rank, tripId)`. Ten boards → stored as `deck_format = 'grid.v1'`, `deck = boards`.
  Fewer than ten → the Trip opens in client mode (no deck), as design §4.4 "no active release → client mode"; logged once.
- Response: `POST /v1/trips` (opened and replayed) adds `codeSearchBoards` at the root **only** when the Trip has a `grid.v1`
  deck; absent otherwise (Unity refuses a non-empty `codeSearchBoards` on another module). Complete and abandon unchanged.
  Board: `{ id, width, height, letters, durationSeconds, clueMode, targets: [{ airportId, code, clue, cityClue, cells:
  [{ row, column }] }] }` (cells in reading order; `code` and `clue` as stored).
- Rounds, completion, Cards, awards, Logbook, UGS copy: unchanged.

## 4. Dev seed step (`npm run demo:seed-code-search`)

- `scripts/demo-seed-code-search.mjs` (thin CLI) + `src/content/code-search-seed.ts` (core, tested in-process).
  `npm run demo:seed-code-search -- --pack <code_search_master.json> [--yes]`. Dry run by default.
- Refusals before connecting (exit 2, pure): unknown/missing arguments; a `DATABASE_URL` naming no database, a name ending `_prod`,
  or `APP_ENV=production` with a name not ending `_dev` (the existing `devDatabaseRefusal`); `--yes` with `BLOB_STORE=none` (the
  import receipt stores the generated sheet like every Admin import). Unlike `demo:seed-content`, a `demo-` project and a memory
  store are allowed (no principals, no photos). No Bunny photo work.
- Pack checks (read with `readRegularFile`, size cap 16 MB): `schemaVersion 2`, `moduleId code-search`, `checkRankTable`, distinct
  ids, every record valid for its rung. Any failure → exit 2, nothing contacted.
- One write path: the core turns the pack into the client-sheet layout of §2 (`writeSheet`) and runs `ContentService.dryRun`, then
  `apply` with `confirm = planHash`, as operator `operator:<os user>`. Replay or all-unchanged → "unchanged". Creates only → apply.
  Any update or retirement → **refused** with the counts (the seed never overwrites stored content; the user does that in the
  Admin import). Run lock: the existing session advisory lock pattern. Output: one line per rank with counts, then the totals;
  the dry run on an empty database prints `would create 3740 boards`.

## 5. API, contracts, docs

- API 0.30.0 → **0.31.0** (additive): import, items, export and trip-coverage routes list `code-search`; coverage `policy` enum
  gains `grid-draw.v1`; `POST /v1/trips` 200/201 gain the optional `codeSearchBoards` (schemas `CodeSearchBoard`,
  `CodeSearchTarget`, `GridCell`). `test/openapi.e2e.test.ts` stays green.
- `contracts/grid.v1.json` new, `dealer.v1.json` regenerated, `contracts/README.md`.
- Docs: design doc row `code-search` and §7 step 7 (built, with the departures above), ARCHITECTURE (server deals Code Search from
  items), TASKS (this slice with verification), README (the seed command).

## 6. Slices and file ownership

| Slice | Files | Depends on |
|---|---|---|
| A rules | `src/rules/{word-grid,code-search-ladder,grid-draw,grid-fixture}.ts`, `src/rules/dealer.ts` (policy entry, `next`), `scripts/write-contracts.mjs`, `contracts/*`, tests `test/{word-grid,code-search-ladder,grid-draw}.test.ts`, `test/dealer.test.ts`/`contracts.test.ts` touch-ups | — |
| B content + seed | `src/content/modules/code-search.ts`, `content-modules.ts`, `src/content/grid-boards.ts`, `content.service.ts` (coverage branch), `src/content/code-search-seed.ts`, `scripts/demo-seed-code-search.mjs`, `package.json` script, tests `test/code-search-mapping.test.ts`, `test/code-search-seed.{test,e2e.test}.ts` | A |
| C trips + API | `src/db/{schema,enums}.ts`, `drizzle/0030_*`, schema-parity list, `src/trips/{trips.service,trip-store,trips.controller}.ts`, `docs/openapi.yaml`, app version, tests `test/code-search-trips.e2e.test.ts`, `test/migration-0030.e2e.test.ts`, openapi test | A (B's `rowToGridBoard` for the e2e: C imports it, B owns it) |

B and C run in parallel after A. Docs (§5) by the lead after review.

## 7. Tests

Unit: validator port (each Unity case), ladder, rank table, `drawGridBoards` (determinism, distinctness, own rank only, < 10 →
empty, seed sensitivity, matches `contracts/grid.v1.json`), mapping (fixtures + real pack), seed refusals and pack checks.
E2E (`airplane_games_test`): import the real pack (or a synthetic one when absent) through the seed core: dry run writes nothing
and reports 3,740; apply; second apply unchanged; open a Code Search Trip at Trainee → 10 distinct Trainee boards in wire shape,
each passing the validator port; replay with the same key → same boards; another module's open carries no `codeSearchBoards`;
too few boards at a rank → client mode; a board retired after open does not change the stored deck; trip-coverage for
`code-search` answers 10 at every rank; migration 0030 CHECK refuses a deck without a format.

## 8. Not in scope

Releases for Code Search; per-Round board delivery (R-1); the grid answer check; Unity changes (listed for the Unity session);
running the seed against the hosted dev database (needs the user, as `demo:seed-content`).

## 9. Open questions

- **User: R-1** (§0.3): keep all ten boards at Trip open for Code Search, or one per `IssuedRound`?
- Unity: decode `codeSearchBoards` from `POST /v1/trips`; port `grid-draw.v1` (replace `System.Random` in `CodeSearchContent.Deal`
  with `DeckRandom`) and add parity tests against `contracts/grid.v1.json`; the mock deals at Certified Rank, the server at Active Rank.

## G. Plan-gate changes and rulings (binding; override §0-§9 where they differ)

**Ruling R-1 exception (user, 2026-11-25, relayed by the coordinating session, verbatim "All ten at Trip open").** Code Search
sends all ten boards in the root `codeSearchBoards` of `POST /v1/trips` (opened and replayed), the shape Unity decodes today. The
deck stays stored server-side. Recorded in the design doc's R table as R-6. §9's R-1 question is closed.

**Dev-only switch (senior-lead 2).** Dealing from `content_items` runs only when config `DEAL_FROM_ITEMS` lists the module
(comma list; only `code-search` accepted, anything else refuses to boot; default empty = off everywhere). Allowed under
`APP_ENV=production` because the hosted dev backend runs production; the prod env file leaves it unset. `.env.example`,
`server/` env notes (message to the lead session) and ARCHITECTURE say so. A test pins default off: with the switch off a
`code-search` Trip opens in client mode with no `codeSearchBoards`.

**Policies (backend 4, senior-lead 3).** `DealPolicy` stays choice-only and `dealer.v1.json` stays byte-identical, so Unity's
`DealerContractParityTests` stays green. New `GridPolicy = "grid-draw.v1"` and `GRID_DEAL_POLICY = { "code-search": "grid-draw.v1" }`
in `src/rules/grid-draw.ts`; `contracts/grid.v1.json` carries the module and policy. The trip-coverage route serves the union of
both maps (coverage `policy` enum gains `grid-draw.v1`); with `itemIds` it counts those ids' boards as for choice modules.
This departs from the brief's "added to DEAL_POLICY" on purpose.

**Deck storage: table, not trips columns (backend 5 + optional, senior-lead 5).** Migration 0030 adds `trip_decks`
(`trip_id` uuid PK FK → trips ON DELETE CASCADE, `format` text CHECK IN `DECK_FORMATS` = (`grid.v1`), `deck` jsonb CHECK
`jsonb_typeof = 'array' AND jsonb_array_length = 10`, `created_at`), a trigger refusing UPDATE (deletes only by cascade). No
trips column changes, so `lockTrip`, the Logbook and R4's future "dealt iff all set" CHECK are untouched; R4 reads `trip_decks`
or migrates it (written into the design doc). Element: `{ itemId, itemVersion, board }` (board = the wire board). The module
rule (`grid.v1` only for `code-search`) is enforced in code and tested. Schema parity: `EXPECTED_ENUM_CHECKS` gains the format
check; the shape check goes in `RULE_CHECKS`. Each CHECK tested in `test/migration-0030.e2e.test.ts`. About 14 KB per Trip,
kept with the Trip (ARCHITECTURE).

**Trip open (backend 6, senior-lead optional).** The Trip id is generated before the deal (seed = Trip id). Under the player
lock: select `id, version, rank` of approved `code-search` rows at the Trip's rank, sort with `compareIds` in JS, fetch `data`
only for memo misses; memo keyed `(id, version)`, values frozen, entries not in the current pool evicted. One mapper builds
`codeSearchBoards` from the stored deck on both the open and the replay path (jsonb reorders keys); a test deep-equals them.

**Content module (backend 1, 2; senior-lead 9; game-domain 5, 6).**
- `naturalKey(data)` = the target codes joined by a space (non-blank, display only).
- New optional mapping hook `validateItem(id, rank, data): string[]` (rank fit to the rung, id prefix matches rank), called by the
  sheet parser and by `ContentItemEditService.edit` (also for a rank-only change) → 422 `import_invalid`. Military, Airport and
  Identifier leave it unset (behaviour byte-identical). Tests: rank-only edit to another rung refused; export → re-import of all
  rows is all `unchanged`; a staff edit of a board.
- `validatePayload` refuses non-canonical input (lower-case letters, untrimmed code or clue) instead of normalising.
- `rowToGridBoard` also drops a board whose id prefix does not match its rank.
- Rank names: the sheet's `Level` holds display names (`rankDisplayName` / `rankFromDisplayName`); the seed converts the pack's
  Unity enum names (`FirstOfficer`) through the catalog's `unity` names, tested.
- Synthetic fixtures (`contracts/grid.v1.json`, unit fixtures) use `FIXTURE-` ids that the importer refuses. E2E uses
  `test/fixtures/code-search-sample.json`: 12 real boards per rank copied from the pack (client content, test only), plus the
  full pack when present.

**Seed (backend 3, 7; senior-lead 6; game-domain 4).**
- `--yes` needs `BLOB_STORE=bunny` under `APP_ENV=production` (the import receipt's file must outlive the command); `memory` is
  allowed only for `APP_ENV=local`/`test`. The put is the generated import sheet (~1-2 MB, `backend/imports/code-search/…`), as
  every Admin import does; no photo work.
- Pack provenance required: `reviewState = "client-supplied"`, 64-hex `sourceSha256`, non-blank `packId`/`contentVersion`; the
  generated file name is `code-search-<contentVersion>-<sourceSha256 first 12>.xlsx` (recorded on the receipt) and the run prints
  all four.
- Never relies on byte replay (write-excel-file zips are not byte-stable): apply only when the dry run is not a replay and has
  `created > 0` and no update or retirement; always passes `confirm = planHash`. Update or retire → refused (exit 3) with the
  counts. Test: a second `--yes` writes no `content_imports` or `admin_audit` row.
- Size test: the generated sheet for the real pack and an Admin export of it stay under `MAX_UPLOAD_BYTES` and
  `MAX_UNPACKED_BYTES` (skip when the pack is absent).

**Slicing (senior-lead 4).** A (rules + pure board mapping `src/content/grid-boards.ts`) first. Then B (mapping, coverage, seed)
and C (migration, trip open, switch, openapi incl. B's route enums, API 0.31.0) in parallel; C's e2e inserts fixture rows
directly and does not need B. `docs/openapi.yaml` and the version are C's only. The lead runs the cross-slice e2e (seed → open)
after integration. Docs by the lead.

**Commands per slice (senior-lead 8).** From PowerShell (uppercase drive): `npm run typecheck`, `npx vitest run <files>`,
`npm run test:e2e -- <files>` on `airplane_games_test`; C: `npm run db:generate -- --name code_search_decks` then a second
`db:generate` reporting no changes; A: `npm run contracts:write` and `test/contracts.test.ts`.

**Docs (game-domain 2, 3; senior-lead optional).** Design: R-6; row `code-search` and §7 step 7 built (dev, from items, behind the
switch); §4.2 timers now sent for Code Search (client clocks 2026-11-19); Q-U9 closed for Code Search (client master
2026-11-17; filler letters from Unity's importer, stored as-is, never regenerated). Seeded boards are dev-only: the master marks
its 421 airports "Verify before publishing" (Unity `CLIENT_CONTENT_IMPORT.md`).

**Unity list (game-domain 7, 8).** (1) A `/v1/trips` client that decodes `codeSearchBoards` (reuse the `DecodeCodeSearch` board
loop) and a decision for an open without boards (switch off or < 10 boards: refuse, or fall back to the bundled pack).
(2) Port `grid-draw.v1` (`DeckRandom` partial Fisher-Yates instead of `System.Random`) with parity tests on
`contracts/grid.v1.json`. (3) The mocks deal at Certified Rank; per `points-progression.md` (Pleasure Cruise) they should deal at
Active Rank, as the server does; same in the ATC and Call Sign mocks. (4) One board = one Flight (backend Round), the deck = one
Trip (ADR-0007).
