# Trips, Field Awards, Clipper Cards, Logbook and the content manifest

**Status:** designed 2026-10-29; slice T1 (pure rules) built 2026-10-29, T2-T6 not built. Contract: the `x-planned` operations and schemas in
[`../openapi.yaml`](../openapi.yaml) (the parity test asserts they answer 404 today). Owner: this session (backend repo).

Binding inputs: `docs/TASKS.md` Decisions 2026-10-29 "contract round 1" and "contract round 2", D-1, D-3, D-5, C5, C12.
Everything below that is not one of those rulings is a proposal; the open points are numbered at the end (U = user
decides, J = client/Josh decides, A = `ASSUMPTION:` test until ruled).

## 0. Vocabulary

| Backend (type names) | Unity (descriptions, ADR-0007) | Wire (ruled names) |
|---|---|---|
| Round | Flight | `/v1/rounds`, `roundId` |
| Flight Segment (10 Rounds) | Trip | `/v1/trips`, `tripId`, `trip` |
| Module | game | `module` (Unity `ModuleRegistry` BackendId) |

Trap: Unity's `LifetimeTotals.Rounds` / `PerfectRounds` / `BestRoundStreak` and `RecentFlightsLog.RoundRecord`
predate ADR-0007 and mean **Trips**. The Logbook contract uses `trips`, `allCorrectTrips`, `bestTripStreak`.

## 1. Sources read

| Fact | Source |
|---|---|
| Trip sketch: `POST /v1/trips {moduleId, flightCount, localDate, utcOffsetMinutes, contentVersion}`, `tripId` on Rounds, Flight facts `{aircraftKey, answerMs, attempts}`, `complete` → `fieldAwards`/`clipperCards`/`replayed`; pull manifest | Unity `docs/architecture/ADR-0008-backend-sync.md` §2, §3 |
| 10 Flights per Trip, 1 hint per Flight, per-module/rank timers | `Assets/_Project/Scripts/Gameplay/Trip/TripProfiles.cs` |
| Trip = start, deal, settle each Flight (outbox key per Flight), complete only after all 10 acknowledged; no explicit abandon | `Application/Services/Trip/TripSession.cs` |
| 28 Field Awards, code ids, metrics | `Gameplay/Achievements/Achievements.cs` (`AchievementCatalog.Starter`, `AchievementMetric`, `PilotRecord.Value`) |
| `FlightFact`, counters, Go Around, Ace streak, Red-Eye window 22:00–05:00, Quick ID < 2 s, scopes | `Gameplay/Achievements/AwardCounters.cs` |
| Tag table (authored by us, pending the client's grid), normalisation letters+digits | `Gameplay/Achievements/AircraftTags.cs` |
| Card record (first collected, times identified, ever-perfect latch) | `Gameplay/Logbook/CardRecord.cs`, `LogbookCollection.cs` |
| RECENT FLIGHTS = last 20 Trips | `Gameplay/Logbook/RecentFlightsLog.cs` (`Capacity = 20`) |
| TODAY / STREAK cells, site-day rules | `Gameplay/Progression/DailyFlightLog.cs` |
| Career totals | `Gameplay/Progression/LifetimeFlightStats.cs` |
| Hint grants: starter 5, +1 per 4 completed Trips, +1 per 7 consecutive played days | `Gameplay/Economy/HintBank.cs` |
| Manifest wire model and client | `Infrastructure/Networking/ApiWireModels.cs` (`ManifestWire`, `ModuleWire`), `HttpContentManifestService.cs` |
| Perfect Streak is per Trip (session) | `docs/design/specs/logbook-hangar-debrief.md` §1 (ruling 2026-09-03; D-3) |
| Field Award rulings and open client questions | `docs/implementation/CLIENT_CONTENT_IMPORT.md` "Field Awards", "Military" |
| Sheet text, thresholds, rulings, reviewer notes | `Assets/_Project/Content/ClientContent/Snapshots/field-awards.json` (snapshot of `../docs/Field Awards #1.xlsx`, sha256 `a41ae3b7…`) |
| Commercial Card families | `Resources/ClientContent/identifier_questions.json` (`family`) |
| Catalog contract, dealer B1–B5 | `../docs/briefs/cross-repo-catalog-dealer.md` |
| PlayerBalance invariants, the open Field-Award/version question | `../docs/briefs/backend.md` (S2 interface, open questions) |

## 2. Flight Segment lifecycle

```
                POST /v1/trips (abandons the previous open segment; a full one is completed instead)
                        |
                        v
   +--------------- open ----------------+
   |  rounds_banked 0..10                |  POST /v1/rounds {tripId}  -> Round n (n = banked + 1)
   |  one open Round at a time           |  POST /v1/rounds/:id/result -> banks Round n, n += 1
   |  expires 30 min after last activity |  (re-issue while Round n is open: abandon it, same n)
   +---+-------------+-----------------+-+
       |             |                 |
 banked = 10   POST .../abandon   expiry or a newer
 POST .../complete   (banked < 10)  segment (banked < 10)
       |             |                 |
       v             v                 v
   completed      abandoned        abandoned   (status `abandoned`; `trip_expired` vs `trip_closed` on later calls)
```

Rules:

1. **One open segment per player** (unique partial index, as Rounds have today). The one-open-Round index stays.
2. **Opening** snapshots module, rank (Active Rank, contract round 1 (4)) and Pleasure Cruise for the whole segment;
   records `localDate`, `utcOffsetMinutes`, `contentVersion`. Resets the Perfect Streak to 0 (D-3).
3. **Rounds** carry `trip_id` and `flight_number`. A Round's module/rank/Pleasure Cruise come from the segment.
   Issue when 10 are banked: 409 `trip_full`. Re-issue while the current Round is open: it is abandoned (no refund for
   a spent hint, as today) and the new Round keeps the flight number (U5). The 30 min Round expiry and 3 s floor stay.
4. **Complete** only with 10 banked Rounds (409 `trip_incomplete` otherwise); allowed after `expiresAt` once full;
   idempotent replay. Opening a new segment while a full one is still open completes the full one first (U4).
5. **Abandon** (optional for the app): banked < 10 → `abandoned`; full → 409 `trip_full`; completed → 410
   `trip_closed`; already abandoned/expired → 200 `replayed`.
6. **Expiry** is lazy: there is no sweeper. A segment past `expiresAt` with fewer than 10 banked Rounds is treated as
   abandoned by every route that touches it, and is marked so by the next write (U4).
7. **Account deletion** cascades segments with the player, like Rounds.

Unity mapping: `TripSession.StartAsync` → `POST /v1/trips`; `SubmitAsync` → issue + result; `CompleteAsync` →
`complete`. `StartAsync` already flushes the outbox before starting, so a pending `complete` reaches the server before
the next `POST /v1/trips` (and rule 4 covers it if it does not).

## 3. What the client reports, what the server computes

| | Client reports | Server computes |
|---|---|---|
| Open | module, `flightCount` (= 10), `localDate`, `utcOffsetMinutes`, `contentVersion` | rank and Pleasure Cruise (Active Rank), expiry, streak reset; checks `localDate` against server time + offset (±15 min) |
| Round result | `finished`, `errorCount`, `usedHint`, `timeRemainingFraction` (today) + `aircraftKey`, `answerMs`, `attempts` | award (`bankRound`), per-segment streak, paid-or-claimed hint, local played day, day streak, 7-day hint grant |
| Complete | nothing (no body) | outcome, Go Around, Red-Eye, Cards, Field Award counters and awards, Trip hint grant |

### 3.1 Perfect Streak per segment (D-3)

`bankRound(state, input, now)` stays pure; the caller passes `state.perfectStreak` = the segment's streak instead of
the lifetime one. Storage: `players.perfect_streak` keeps meaning "the live streak" but is reset to 0 when a segment
opens, completes or is abandoned (U13); `trips.best_streak` keeps the debrief's best. So `Progress.perfectStreak` and
`UgsMirrorProgress.perfectStreak` keep their names and types; only the meaning narrows (documented as
`x-planned-properties` on `Progress`). Streak Miles still pay on the streak carried into a Round (README question 4).

Not to be confused with **Ace in the Cockpit** (`five-in-a-row`): its perfect-Flight streak runs ACROSS segments over
Identifier Rounds only (Unity `AwardCounters.PerfectFlightStreak`), a separate counter.

### 3.2 Flight facts (`RoundResultWithFlightFactsRequest`)

- `aircraftKey`, module by module:
  - `identifier`: the Unity family of the question's correct answer (`identifier_questions.json` `family`, e.g. `787`).
    That is the commercial Card key (contract round 2 (4): commercial Cards keep Unity's families).
    **Gate (T2/T3 rule):** the value must be an exact key of the seeded commercial Card catalog (U9;
    `SEED_COMMERCIAL_CARD_KEYS`, checked by `cardKeyFor(module, value, catalog)`). Anything else (a typo, `a320`, a
    Military key such as `mil:...`) answers the Round result with **400 `invalid_request`** and banks nothing, so a case
    variant or an unknown family can never create a second Card. (Alternative, not chosen: bank the Round and give it no
    Card; that would hide a client bug and silently drop Card progress.) The catalog is read from the clipper-cards
    document once T4 lands.
  - `aircraft-identifier-military`: **proposed** — the content item id (`mil-a4`); the server reads the item's
    `answer` from `content_items` (approved or retired, A6) and derives the Card key. Reason: ADR-0008 §2/§3 asks for
    "a roster id for military", the ruling keys the Card by the answer text, and only the id lets the server check the
    value against stored content. Alternative: send the answer text (U3).
  - every other module: null.
- `answerMs` ≤ server issue-to-result time + 2,000 ms (A5); feeds Bogey Identified. A Bogey answer under 2 s still
  waits out the 3 s floor (429 `round_too_fast`, retry), so the two rules do not conflict.
- `attempts` ≥ `errorCount`, ≥ 1 when finished (A4). It is recorded; scoring keeps using `errorCount`.
- "Correct" = `finished`; "perfect" = finished, `errorCount` 0, no hint (paid or claimed) — Unity `FlightFact`.

### 3.3 Days, the day streak and the 7-day hint

A Round's **local day** = date(server time of its result + the segment's `utcOffsetMinutes`). Per player
(`player_counters`): `last_played_date`, `flights_on_last_played_date`, `day_streak`, `best_day_streak`, updated in the
Round result transaction with `HintBank.RecordFlight`'s rule: day ≤ last → count it on the last day, no streak change;
day = last + 1 → streak + 1; later → streak = 1. On every increment where `day_streak % 7 == 0` the server posts
`hint_ledger` `+1`, kind `day_streak_grant`, ref = the local date (idempotent by UNIQUE(player, kind, ref)). A Round
of an abandoned segment still counts as play (A2), as in Unity. The phone clock never enters: a rewound clock cannot
make an earlier day "new" (site-day ruling, ADR-0008 §2), and a changed offset can at most move the day forward.

### 3.4 Trip hint grant

At `complete`, `trips_completed += 1`; when `trips_completed % 4 == 0`, `hint_ledger` `+1`, kind `trip_grant`, ref =
tripId (Unity `HintBank.CompleteTrip`). Every completed segment counts, any module, Pleasure Cruise included (A1).
New kinds need the `hint_ledger_kind_check` drop/re-add migration, the `HINT_LEDGER_KINDS` list and the S5 parity
test (contract round 2 (3)).

### 3.5 Clipper Cards

Collected at `complete` only (A7: an abandoned segment collects nothing). This follows ADR-0008 §2 (`complete`
returns the newly collected Cards) and Unity's counters (`LifetimeFlightStats.RecordTrip` at Trip end), but differs
from Unity's Logbook, which collects a Card on each correct Flight as it settles (`OnlineIdentifierSession.CollectIfEarned`);
see §11. Every finished Round with a non-null `aircraftKey` upserts `player_clipper_cards(player,
card_key)`: first time = collected (returned in `clipperCards`), later = `times_identified + 1`; latches
`ever_perfect` (perfect Round) and `ever_hint_free` (finished without a hint); keeps `fastest_correct_ms`.

Card keys:
- Commercial: Unity family (`787`), `keySource: unity_family`.
- Military (contract round 2 (4)): `mil:` + the client's answer text normalised (A14: NFC, format characters
  removed, dash variants folded to `-`, whitespace runs one space, spaces around `/` removed, trimmed, lower-cased),
  `keySource: client_answer_text`. The `mil:` namespace means a Military key can never equal a commercial family key
  (A20). Eurofighter Typhoon (`mil-a4`, `mil-a8`, `mil-a26`) is one Card; T-28 (`a17`/`a23`) and AW139 (`a22`/`a27`)
  likewise. The sheet has **27 distinct correct answers** (31 rows; checked against the real xlsx 2026-10-29). The three
  C-130 answers stay three Cards until the client supplies a family mapping (J2). `Boeing F/A-18 Super Hornet` is **not**
  a client answer (it is only a wrong option in `mil-a4`; the sheet's answer is `Boeing F/A-18E/F Super Hornet`), so it
  is no Card and the "two Super Hornet Cards" case does not exist today.
- **The Military key is computed once, at the item's first import, and FROZEN on the content item** (a `card_key`
  field written by the importer, T2/T3). A later staff or client text edit of the answer (a typo fix, a changed
  dash) keeps the key, so collected Cards, `times_identified` and the tag table entry survive. The Round result and
  `complete` read the frozen key from the item, never re-derive it; only a new item (a new row) gets a new key, and two
  items whose answers normalise equal share one Card by design (Typhoon x3). Normalisation changes in later releases
  therefore cannot orphan existing Cards.

Note the three normalisations in play: this Card key (A14); Unity's tag lookup
`AircraftTagTable.Normalize` (letters and digits only); the dealer's `normalizeAnswer` (letters and digits, brief B3).
The tag document is keyed by Card key, so only one is used for awards.

### 3.6 Field Awards: all 28

Ids are the Unity code ids (contract round 1 (2)); title, criteria and threshold cell are the sheet's, verbatim; the
numeric target comes from the threshold cell plus the client's rulings in the snapshot. No award pays Miles or SP.
Scopes follow Unity `AwardCounters` (its doc comment records them as user-approved).

| # | Code id (sheet id) | Sheet title | Metric | Target | Server rule |
|---|---|---|---|---|---|
| 1 | first-flight (first-solo) | First Solo | trips-completed | 1 | completed segments, any module |
| 2 | frequent-flyer | Frequent Flyer | trips-completed | 25 | |
| 3 | century (logbook-100) | Logbook 100 | flights-completed | 100 | Rounds in completed segments |
| 4 | sharp-eyes (vfr-certified) | VFR Certified | identifier-full-trips | 1 | completed Identifier-module segments (both Identifiers), all correct |
| 5 | flawless-five (five-by-five) | Five-by-Five | identifier-full-trips | 5 | not necessarily consecutive |
| 6 | five-in-a-row (ace-in-the-cockpit) | Ace in the Cockpit | best-perfect-flight-streak | 5 | perfect Identifier Rounds in a row across completed segments; other modules neither extend nor break it |
| 7 | week-on-the-line (line-pilot) | Line Pilot | best-day-streak | 7 | §3.3 |
| 8 | regular (30-days-on-the-ramp) | 30 Days on the Ramp | best-day-streak | 30 | not hidden (sheet) |
| 9 | first-card (first-clipper-card) | First Clipper Card | cards-collected | 1 | commercial + Military Cards |
| 10 | collector (curator-of-the-skies) | Curator of the Skies | cards-collected | 25 | |
| 11 | textbook (textbook-landing) | Textbook Landing | perfect-cards | 10 | Cards with `ever_perfect` |
| 12 | high-flyer | High Flyer | miles-earned | 100,000 | Miles earned in completed segments |
| 13 | coast-to-coast | Coast to Coast | miles-earned | 10,000 | same metric (J10) |
| 14 | no-instrument-flight | No-Instrument Flight | best-hint-free-trip-streak | 5 | consecutive completed segments, any module, no hint |
| 15 | red-eye-special | Red-Eye Special | night-trips | 1 | completion local time in [22:00, 05:00) (A3) |
| 16 | fleet-admiral | Fleet Admiral | cards-collected | 50 | client ruling 2026-10-28 |
| 17 | centennial-streak | Centennial Streak | best-day-streak | 100 | |
| 18 | go-around | Go Around | go-arounds | 1 | all-correct segment right after a completed segment that was not; first ever never counts; any module (J1); "correct" = any correct Flight, hinted or second-try included (A18, J12) |
| 19 | globe-trotter | Globe Trotter | miles-earned | 24,901 | client confirmed "lifetime Miles earned" |
| 20 | quad-engine-royalty | Quad-Engine Royalty | quad-engine-cards | 2 | Cards tagged quad-engine (jets only, client ruling) |
| 21 | the-great-rivalry | The Great Rivalry | rivalry-balance | 10 | min(Boeing Cards, Airbus Cards) |
| 22 | heavy-metal | Heavy Metal | heavy-cards | 5 | Cards tagged heavy (the sheet's list) |
| 23 | regional | Regional | regional-cards | 5 | Cards tagged regional-jet |
| 24 | bogey-identified | Bogey Identified | quick-fighter-id | 1 | a Military Card tagged fighter-attack and not piston with `fastest_correct_ms` < 2,000 |
| 25 | top-gun-ace | Top Gun Ace | fighter-aces | 10 | Military Cards tagged fighter-attack with `ever_hint_free` |
| 26 | rotorhead | Rotorhead | rotary-identified | 4 | Military Cards tagged military-rotary |
| 27 | vertical-horizon | Vertical Horizon | vtol-identified | 1 | Military Cards tagged vtol |
| 28 | executive-platinum | Executive Platinum | cards-collected | 100 | |

Evaluation runs once per `complete`, inside the transaction, against the catalog version in force (recorded on the
segment). An award whose `current >= target` and that has no row yet is inserted into `player_field_awards` and
returned in `fieldAwards`. Earned awards are never removed (Unity: "an award never un-earns"; U7 for raised targets).
Tag-derived counts (20–27) are computed from the Cards and the tag document in force, so a tag correction moves them
at the next `complete` without a data migration.

**Locked, not hidden.** Every award is always on the board with `current/target`; with today's content several cannot
be reached (CLIENT_CONTENT_IMPORT: Fleet Admiral 50, Executive Platinum 100 and The Great Rivalry cannot; Regional
needs 5 regional Cards but only E175 and CRJ exist; **Rotorhead needs 4 rotary Cards but the client's 27 Military
answers hold only 2, the AW139 and the AS332 Super Puma**). **Vertical Horizon depends on J5**: the only VTOL-tagged
aircraft among the client's answers are those same two helicopters (our provisional table tags helicopters as VTOL); if
the client's grid says helicopters are not VTOL, it has no reachable aircraft until a Harrier or F-35B is delivered.
They simply stay locked; the server never invents content or lowers a target (J6). Military Cards change
reachability: Curator of the Skies (25) becomes reachable with 12 commercial Cards plus the 27 distinct Military
answers, and Quad-Engine Royalty with the C-17 (J3).

### 3.7 Go Around and the other segment counters

`player_counters` (one row per player) holds the Unity `AwardCounters` that cards cannot derive: identifier full
trips, perfect-flight streak and best, hint-free trip streak and best, night trips, go-arounds, previous trip outcome,
plus trips/flights/correct/all-correct/miles totals and the best in-segment streak (Logbook `lifetime`). All are
updated at `complete` from the segment's 10 Rounds in flight order (`WithTrip`), then the awards are evaluated. They
are a cache of what the stored segments and Rounds already say: slice T3 includes a re-derivation test that rebuilds
them from `trips` + `rounds` and compares.

## 4. Data model sketch (migrations 0009–0011)

```
trips                                   -- 0009
  id uuid PK, player_id -> players ON DELETE CASCADE
  module CHECK IN MODULE_LIST, rank CHECK IN RANK_LIST, pleasure_cruise bool
  status CHECK IN ('open','completed','abandoned')
  flight_count int CHECK = 10, rounds_banked int CHECK 0..10
  local_date date, utc_offset_minutes int CHECK -720..840, content_version text CHECK length 1..64
  opened_at, expires_at (CHECK > opened_at), closed_at NULL
  -- set at complete:
  outcome CHECK NULL OR IN ('all_correct','not_all_correct'), correct int 0..10, hint_used bool,
  best_streak int 0..10, miles int >= 0, status_points int >= 0, go_around bool, night_trip bool,
  completion_local_date date, catalog_version int
  CHECK status <> 'completed' OR (rounds_banked = 10 AND outcome IS NOT NULL)
  UNIQUE (player_id) WHERE status = 'open'; INDEX (player_id, closed_at DESC) WHERE status = 'completed'

rounds (0009, ALTER)
  + trip_id uuid NULL -> trips ON DELETE CASCADE, + flight_number int NULL CHECK 1..10
  + aircraft_key text NULL, + card_key text NULL, + answer_ms int NULL CHECK 0..1800000, + attempts int NULL CHECK >= 0
  + local_date date NULL (set when banked)
  UNIQUE (trip_id, flight_number) WHERE status = 'completed'
  CHECK (trip_id IS NULL) = (flight_number IS NULL)
  -- NULL trip_id only for pre-Trip dev rows (A11); new Rounds always have one

hint_ledger_kind_check (0009, drop/re-add): + 'trip_grant', 'day_streak_grant'

player_counters (0009)                  -- PK player_id -> players ON DELETE CASCADE, every int CHECK >= 0
  trips_completed, flights_completed, correct_flights, all_correct_trips, miles_earned bigint, best_trip_streak,
  identifier_full_trips, perfect_flight_streak, best_perfect_flight_streak, hint_free_trip_streak,
  best_hint_free_trip_streak, night_trips, go_arounds, previous_trip_outcome NULL|enum,
  last_played_date date NULL, flights_on_last_played_date, day_streak, best_day_streak, updated_at

player_clipper_cards (0010)             -- PK (player_id, card_key), player -> players ON DELETE CASCADE
  module CHECK IN ('identifier','aircraft-identifier-military'), first_collected_at, first_trip_id uuid,
  times_identified int >= 1, ever_perfect bool, ever_hint_free bool, fastest_correct_ms int NULL

player_field_awards (0010)              -- PK (player_id, award_id), player -> players ON DELETE CASCADE
  award_id CHECK IN FIELD_AWARD_IDS (28 literals; S5 parity test against src/rules/field-awards.ts)
  earned_at, trip_id uuid, catalog_version int

content_documents (0011)                -- PK (name, version); immutable rows
  name CHECK IN ('field-awards','clipper-cards','aircraft-tags'), version int >= 1, format text,
  body jsonb, sha256 text CHECK hex64, byte_size int > 0, created_at, created_by (principal), note text
  -- the manifest lists MAX(version) per name; old versions stay fetchable
```

Every table above that holds player state is written only inside `PlayerBalance.update`'s transaction, through `p.tx`
(the balance guard already allows callers' own tables there). `drizzle-kit generate` per slice; applied migrations are
immutable; enum literals get TS lists and the S5 parity test.

## 5. PlayerBalance: every award through `update`

| Write | `Step` | Version bump | Mirror |
|---|---|---|---|
| Open segment | abandon/complete the previous one (own tables) + `perfectStreak: 0` | only if the streak was not 0 (invariant 3) | enqueued when it bumps |
| Round in segment, result | as today + `day_streak_grant` posting when due | always (completed Round, D-1) | paced (C3) |
| Complete | `trip_grant` posting when due, `perfectStreak: 0`, cards/counters/awards in own tables, `republish: true`, `mirrorNow: true` | when a hint or the streak changes (U2) | **due now**: the "write at Trip end" hook S7 built (`Step.mirrorNow`) |
| Abandon | `perfectStreak: 0` | if it changes | paced |

Lock order: player (PlayerBalance) → trip → round → counters/cards. No network call inside `fn`. A `complete` of a
segment the caller does not own maps `no_player`/missing to 404 `trip_not_found`, as Round routes do.

## 6. Logbook derivation (`GET /v1/me/logbook`)

One read transaction, no lock, no writes: `recentTrips` = the 20 newest completed `trips` (index above); `daily` and
`lifetime` and `counters` from `player_counters`; `clipperCards` from `player_clipper_cards`; `fieldAwards` = the
catalog in force × (`player_field_awards` ∪ current metric values). `version` = `players.version`, so the app can
tell a stale cache. The app still owns the presentation flags ("announced", "unseen"; ADR-0008 §1).

`current` is the metric value capped at the target in force, reported as is. A stored award never un-earns (U7), so after
a staff edit raises a target an award can read `earned: true` with `current < target` (25 / 50 and earned). The
Logbook and the app show it as earned and must not derive "earned" from `current >= target`. Targets are integers >= 1;
the evaluator clamps a bad catalog value (`effectiveTarget`), and the T4 publish check rejects one.

## 7. Manifest, versions and caching

- `content_documents` rows are immutable; publishing a change inserts `version + 1` for that name.
- Manifest `version` = a short hash over the sorted `(name, version, sha256)` list plus the module entries, so it is
  stable across instances and restarts without a counter. `ETag` = `"<version>"`; `If-None-Match` → 304;
  `Cache-Control: no-cache`. Documents: `ETag` = `"<sha256>"`, `Cache-Control: private, max-age=31536000, immutable`.
  These are the planned exceptions to the global `/v1` `no-store`.
- Unity compatibility: `ManifestWire` / `ModuleWire` fields keep names and types (`version`, `generatedAtUtc`,
  `modules[] {id, enabled, contentVersion, assetBundleUrl}`). Changes: `documents[]` is new (ignored by today's
  `HttpContentManifestService`, which Unity extends to fetch changed documents and fall back to the bundled
  snapshot); `enabled` is always true (Remote Config is the kill switch, contract round 1 (3)); `contentVersion` and
  `assetBundleUrl` are null until releases (5.2+); no `minClientVersion` (Unity hard-codes 1; the 426 gate is the
  server's tool).
- Seed (slice T4), one migration-time import, never hand-typed: `field-awards` v1 from the sheet snapshot with the
  Unity code ids and the targets in §3.6; `clipper-cards` v1 from `content_items` (Military, keyed per §3.5) plus the
  commercial families (U9); `aircraft-tags` v1 with per-entry `source` (U8).
- Auth: the manifest and documents require a token like every non-health route (U11).

## 8. Admin edits (C12) → manifest versions

Planned staff routes (slice T6, not in this contract yet): read the draft catalog, edit an award's `title`,
`criteria`, `target` or `hidden` (never its id or metric) with a version check like `content_items`, edit Card names
and tags, then **publish**, which writes a new `content_documents` version and one `admin_audit` row
(`action = 'content_publish'`, a new CHECK value). The next manifest read shows the new version; Unity pulls it. A
re-import of a later Field Awards sheet goes through the same plan → confirm → apply path as 5.0 imports (rows matched
by sheet row and title, never guessed). Remote Config gets at most a pointer (the manifest version) and the kill
switches (contract round 1 (3)). Military content edits (5.0) change `clipper-cards` only through a publish.

## 9. UGS copy impact

Proposal (U1): **no change**; the copy stays `schemaVersion` 2 (balances, rank, streak, `version`, `uid`). Field Award
and Card progress stay server-only and reach the app through the Logbook and `complete`. Reasons: the copy is a
first-paint fallback for balances (C3) and a 5 MB-limited, write-budgeted value; the Logbook is not on the first
paint; adding awards would force a `schemaVersion` 3 and a `version` bump on every award. What does change: the copy's
`perfectStreak` follows §3.1, and `complete` asks for a copy write now (`mirrorNow`). If the user wants awards in the
copy: add `fieldAwardsEarned: FieldAwardId[]` in `schemaVersion` 3 and bump `version` at every earning `complete`
(PlayerBalance needs a "touch" bump without a balance change, a change to invariant 3).

## 10. Deferred: server answer checks (with B1–B5 and releases)

Trips v1 records client-reported facts (contract round 2 (2)). When the dealer (brief B3/B4) and releases land,
`POST /v1/trips` returns the dealt deck (seed = tripId, policy per module, pool = the release), the result reports
the chosen option instead of `finished`/`aircraftKey`, and the server derives correctness, the Card key and the
errors itself; `contentVersion` is then checked against the release (unknown → a new 409/422 code). The v1 fields stay
accepted and become derived, so the change is additive. Until then the trust gap ADR-0008 §3 records stays open.

## 11. Contradictions with Unity ADR-0008 and the briefs

1. **Progress hydration.** ADR-0008 §2: `GET /v1/me/progress` grows `fieldAwards[]`, `clipperCards[]`, `counters`.
   Contract round 2 puts them in `GET /v1/me/logbook`; Progress gets nothing new (U2).
2. **Military Card key.** ADR-0008 §3: "Military keys are the website roster ids". Contract round 2: normalised answer
   text. This design uses the ruling for the key and proposes the item id on the wire (U3).
3. **Remote Config.** ADR-0008 §3 "push into UGS: thresholds, flags, `minContentVersion`". Contract round 1 (3):
   Remote Config is kill switch / pointer only; thresholds travel in the catalog document.
4. **`POST /v1/rounds` "gains a tripId".** Here the body becomes `{ tripId }`; module/rank come from the segment.
5. **Military Cards in Unity.** `Achievements.cs` (`PerfectCards` "Military gives no cards") and CLIENT_CONTENT_IMPORT
   ("No Clipper Cards") predate contract round 2 (4); Unity's evaluator must count Military Cards in cards-collected,
   perfect-cards and the tag counts, and drop `MilitaryPerfect` (it would double count).
6. **Clocks.** Unity judges Red-Eye and days on the phone clock; the server uses its clock plus the reported offset
   (ADR-0008 §2's own site-day ruling, made concrete).
7. **Dealing rank.** Unity's mock deals at Certified Rank; contract round 1 (4) deals at Active Rank (Unity changes).
8. **Rotorhead/Vertical Horizon wording.** The sheet says "Collect Clipper Cards for military helicopters" (Rotorhead);
   Unity's text says "Identify". With Military Cards both readings count the same aircraft.
9. **Normalisations** (§3.5): ruling key vs Unity tag key vs dealer dedupe key differ; harmless for today's content,
   but the dealer brief's `normalizeAnswer` and this Card key should be reconciled when the dealer lands.
10. **When a Card is collected.** Unity collects a Card per correct Flight as it settles
    (`OnlineIdentifierSession.CollectIfEarned`), so a quit Trip keeps its Cards; this design collects at `complete`
    (A7, U6). If the user prefers Unity's behaviour, the upsert moves into the Round result and `complete` reports the
    segment's new Cards from `first_trip_id`.
11. **backend.md brief** open question "Does recording Field Award progress bump `players.version` and appear in the
    copy?" stays open as U1/U2.

## 12. Open questions

### User decides

**Resolved 2026-10-29 (user): every U item below takes the recommended answer.** U1 copy stays `schemaVersion` 2
without Field Awards. U2 no bump. U3 content item id. U4 30 min after last activity; a full segment is completed.
U5 yes. U6 yes, as written. U7 as written. U8 seed Unity's table marked `provisional`; tag awards count it until
the client's grid (J5). U9 yes. U10 show the client's text verbatim; staff edits come with T6 and are recorded.
U11 sign-in required. U12 reject with 422 `local_date_mismatch` beyond ±15 min. U13 confirmed. U14 **add** a
required `Idempotency-Key` to `POST /v1/trips` (same key replays the segment it opened). The original questions
stay below for the record.

- **U1** UGS copy: keep `schemaVersion` 2 without Field Awards (recommended), or add earned ids in v3?
- **U2** Does earning a Field Award bump `players.version` (needs a PlayerBalance "touch")? Recommended: no, while
  awards are not in Progress or the copy.
- **U3** Military `aircraftKey` on the wire: content item id (recommended) or the answer text?
- **U4** Segment expiry: 30 min after the last activity (proposed), and a full segment is completed, not abandoned,
  when superseded or expired.
- **U5** Re-issuing a Round in a segment keeps its flight number; an abandoned Round never counts.
- **U6** An abandoned segment keeps its Rounds' Miles/SP and counts for the day streak, but gets no Cards, counters,
  awards or Trip hint. Confirm (Unity's Logbook keeps Cards from a quit Trip, §11 item 10).
- **U7** Admin threshold edits: earned awards stay earned when a target rises; a lowered target is awarded at the
  next `complete` (not on read).
- **U8** Aircraft tags: Unity's table is authored by us (pending the client's attribute grid). Seed it marked
  `provisional` and let the tag awards (20–27) count it, or keep provisional-tag awards locked until the grid arrives?
  (The quad-engine jets list and the heavy list are client rulings either way.)
- **U9** Seed the commercial Card catalog once from Unity's families/Card ids until the Identifier importer (D-2)?
- **U10** Sheet typos (`fligfhts`, `airfract`, the stray bullet and unclosed bracket in Heavy Metal): show verbatim,
  or allow recorded staff edits (T6)?
- **U11** Manifest and documents: authenticated (as written) or public, so the app can pull before sign-in?
- **U12** `localDate` check: 422 `local_date_mismatch` beyond ±15 min (as written), or accept and only record?
- **U13** `Progress.perfectStreak` / copy `perfectStreak` become the open segment's streak (0 when none). Confirm.
- **U14** `POST /v1/trips` without an `Idempotency-Key` (as written: a retry only abandons an empty segment). Add one?

### Client (Josh) decides

- **J1** Go Around scope: one counter over every Arcade game (our reading, ADR-0008 "waiting on Josh"), or per game?
- **J2** Military Card families: do the three C-130 answers (`Lockheed C-130 Hercules`, `Lockheed Martin C-130J Super
  Hercules`, `Lockheed Martin HC-130J Combat King II`) share one Card? (The F/A-18 spellings are no longer a question:
  only `Boeing F/A-18E/F Super Hornet` is a correct answer; `Boeing F/A-18 Super Hornet` is a wrong option.)
- **J3** Do Military Cards count for Curator/Fleet Admiral/Executive Platinum, Quad-Engine Royalty (C-17), Heavy
  Metal and The Great Rivalry (Boeing military types)?
- **J4** Beriev A-50 four-engine? A380 a heavy? (CLIENT_CONTENT_IMPORT)
- **J5** The aircraft attribute grid (replaces the provisional tags; e.g. do helicopters count as VTOL for Vertical
  Horizon, as our table says?).
- **J6** Unreachable targets with today's content (Fleet Admiral, Executive Platinum, The Great Rivalry, Regional):
  more Card content or lower targets?
- **J7** Quad-Engine Royalty criteria lists the A400M, the ruling excludes it: fix the text?
- **J8** Military dealer rule (C13): higher ranks, the 6-Flight cap, rows without a photo (affects the deferred dealer).
- **J9** Does Plane of the Day count as play for day streaks (Unity says it keeps the streak alive; the backend has no
  Plane of the Day)?
- **J10** Coast to Coast / Globe Trotter: Miles earned in completed Trips only (as High Flyer says), or every banked
  Round?
- **J11** Study (untimed) mode: does it report to the backend, and can it ever earn Bogey Identified (Unity: never)?
- **J12** Go Around says "a full green trip (10 green flights)": does "green" mean a perfect light (first pick, no hint),
  or any correct Flight? (Unity paints only a perfect Flight green and a hinted or second-try Flight yellow, but counts
  any correct Flight toward a green Trip; we follow the counting, A18.)

### ASSUMPTION tests (until ruled)

A1 every completed segment counts for the Trip hint, any module, Pleasure Cruise included · A2 a Round of an abandoned
segment counts for the day streak · A3 Red-Eye local time = server time of the 10th banked Round + the offset given at
open · A4 `attempts` ≥ `errorCount` (≥ 1 when finished) is the only consistency rule · A5 `answerMs` ≤ server elapsed
+ 2 s · A6 retired Military item ids are accepted · A7 Cards only at `complete` · A8 a segment's rank is fixed at open
even if Active Rank changes · A9 a re-issued Round keeps the flight number and the streak · A10 `identifier-full-trips`
and the Ace streak count both Identifier modules · A11 pre-Trip Rounds (`trip_id` NULL, local dev data) count toward
nothing · A12 Military tag awards count only Military Cards, the other tag awards count every Card · A13 Go Around: any
module on both sides of the pair (J1); the previous outcome is that of the player's previous COMPLETED segment, so an
abandoned segment neither sets nor clears it; the first completed segment never counts · A14 Card key normalisation (T1): Unicode NFC; remove every Unicode format character (category Cf: zero-width space,
soft hyphen, BOM, joiners, bidi marks); fold the dash variants U+2010-U+2015, U+2212, U+FE58, U+FE63, U+FF0D to `-`;
every run of Unicode whitespace (JS `\s` plus U+0085) becomes one space; spaces around `/` are removed; trim; simple
`toLowerCase`; NFC again. Other punctuation is kept and there is no full case folding (`ß` stays `ß`). The Military key
is this text behind the `mil:` prefix, computed once at first import and frozen on the content item (section 3.5), so
later edits and later changes to these steps never move an existing Card · A15 completing an empty segment is a caller
bug and throws (Unity's `WithTrip` ignores it) · A16 a Military Card counts once in perfect-cards through its own
`everPerfect`; Unity's separate `MilitaryPerfect` set is dropped · A17 the evaluator relies on one Card row per key (the
table's primary key) and on `fastestCorrectMs` being the fastest correct answer of any hint state (Unity Bogey takes the
minimum over correct Flights) · A18 Go Around "green": the client wrote "a full green trip (10 green fligfhts)"; Unity
paints only a perfect Flight green (first pick, no hint) and a hinted or second-try Flight yellow, but its
`AwardCounters` counts any correct Flight toward a green Trip. We keep the counting rule: a Trip is green when all ten
Flights are correct, hints and second tries included, so 10 hinted-but-correct Flights after a non-full Trip earn Go
Around (client question J12; only `tripOutcome` changes if the client says "perfect") · A19 Red-Eye is 22:00 inclusive to
05:00 exclusive on the segment's local clock (the sheet says "between 10:00 PM and 5:00 AM"; the boundary is Unity's
reading) · A20 Military Card keys carry a `mil:` prefix so they can never collide with a commercial family key; the tag
table is keyed the same way. Also tested as ASSUMPTION (J-items): J10 the Miles awards count Miles earned in COMPLETED
segments only (Globe Trotter's "lifetime Miles earned" could include abandoned-segment Rounds); A10 both Identifiers share
the Ace streak and the full-Trip count; A2 and A13-"completed only" have placeholder unit tests that the T2/T3 e2e tests
replace. A13-A20 are named `ASSUMPTION` tests in `test/trips.test.ts` and `test/field-awards.test.ts`.

**Known limitation (A3, DST).** A segment reports one `utcOffsetMinutes` at open and the server applies it to every
Round and to the completion time. A segment that spans a daylight-saving change, or a player who travels across zones
mid-segment, is judged on the opening offset: Red-Eye and the local day can be an hour or more off for that segment.
The offset is fixed per segment on purpose (one clock per Trip); the next segment reports a fresh offset.

## 13. Implementation slices

| # | Slice | Size | Contents | Gate |
|---|---|---|---|---|
| T1 | Pure rules | S | `src/rules/trips.ts` (day-streak step, `withTrip` counters, outcome, Go Around, night window, hint cadence), `src/rules/field-awards.ts` (28 ids, metric evaluation, Card key normalisation); test names aligned with Unity EditMode tests (`FieldAwardsTests`, `AchievementBoardTests`, `HintBankTests`, `DailyFlightLogTests`, `LifetimeFlightStatsTests`, `LogbookCollectionTests`); ASSUMPTION tests | `npm test`. **Built 2026-10-29** (see "T1 as built" below) |
| T2 | Segments and Rounds | M | migration 0009 (incl. the open request's `Idempotency-Key`, unique per player, U14); `src/trips/` module; `POST /v1/trips`, `abandon`; Rounds require `tripId`; Flight facts; D-3 in `bankRound`'s caller; day streak + `day_streak_grant`; drop `x-planned` from those ops and the planned Round changes; schema parity lists | e2e: open/abandon/supersede/expiry, replay, concurrency (two opens, issue vs abandon), openapi parity |
| T3 | Complete | M | migration 0010; Cards, counters, 28 awards, `trip_grant`, `mirrorNow`; catalog from a code constant until T4; re-derivation test | e2e: replay returns the same lists, nothing paid twice, concurrent completes, Go Around sequence, 4th-Trip grant |
| T4 | Content documents and manifest | M | migration 0011; seed field-awards/clipper-cards/aircraft-tags v1; `GET /v1/content/manifest`, `GET /v1/content/documents/{name}/{version}`; ETag/304; T3 reads the catalog from documents | e2e: Unity-compatible manifest, 304, immutable bytes = sha256 |
| T5 | Logbook | S | `GET /v1/me/logbook` | e2e against a seeded history; schema parity |
| T6 | Admin edit and publish (C12) | M | staff routes, version checks, publish, audit; after U7/U10 | e2e: an edit reaches the manifest; Unity pulls it (cross-repo gate in ADR-0008 S2) |

Then the dealer slices B1–B5 (brief), then server answer checks with releases (§10). Each slice: focused commit,
independent review for T2–T4 and T6, verification recorded in `docs/TASKS.md`.

### T1 as built (2026-10-29)

Pure TypeScript only: no route, no Nest provider, no migration; `bankRound` and every built route are unchanged
(the per-segment Perfect Streak needs no `bankRound` change: it already takes `state.perfectStreak`, so T2 passes the
segment's streak and resets the stored one at open/complete/abandon).

| File | Contents |
|---|---|
| `src/rules/trips.ts` | `FLIGHTS_PER_TRIP` 10, `nextTripStreak` / `OPENING_TRIP_STREAK` / `bestTripStreak` (D-3), `flightFact`, `tripOutcome`, `localDateTimeOf` / `addDays` / `daysBetween`, `isNightHour`, `PlayerCounters` + `EMPTY_COUNTERS` (the `player_counters` row), `recordPlayedDay` (+ 7-day hint), `flightsToday`, `liveDayStreak`, `tripHintGrant` (+1 per 4), `applyCompletedTrip` / `withTrip` (Unity `WithTrip`, Go Around, Red-Eye), `deriveDayLog` / `deriveTripCounters` (T3 re-derivation) |
| `src/rules/clipper-cards.ts` | Card keys (`commercialCardKey`, `militaryCardKey` = `mil:` + `normalizeAnswerText`, `cardKeyFor(module, value, commercialCatalog)` -> card / no_card / unknown_aircraft, `cardKeySource`) and `recordSighting` (the `player_clipper_cards` upsert as a pure function) |
| `src/rules/aircraft-tags.ts` | `AircraftTagEntry` / table type and the seed from Unity `AircraftTags.cs`, keyed by Card key, every manufacturer and tag `provisional` except the two client-ruled tags (quad-engine, heavy) |
| `src/rules/field-award-catalog.ts` | the 28 definitions as data: Unity code ids, sheet title / criteria / threshold cell verbatim from the snapshot, target, metric, `hidden`, `provisional` (the eight tag awards), rulings |
| `src/rules/field-awards.ts` | `FIELD_AWARD_IDS` / `FIELD_AWARD_METRICS`, `metricValue`, `evaluateFieldAwards(catalog, {counters, cards, tags}, alreadyEarned)`, `nearlyThere`, `awardCountLabel` |

Differences from Unity found while porting (design and Unity disagree; the design wins, Unity changes):
1. Military Cards count in cards-collected, perfect-cards and the tag metrics (Unity: "Military gives no cards" and a
   separate `MilitaryPerfect` set). Already listed in section 11 item 5.
2. Bogey, Top Gun, Rotorhead and Vertical Horizon read Military Cards (`fastestCorrectMs`, `everHintFree`, tags) instead
   of Unity's per-name sets in `AwardCounters`; same results for the same history.
3. `AwardCounters.WithTrip` takes per-Flight modules; a segment has one module, so `applyCompletedTrip` takes the
   segment's module.
4. Unity's `PilotRecord` falls back to legacy totals for an old save (`IdentifierFullTrips`, Ace streak); the server has
   no legacy data, so there is no fallback.
5. Unity's tag lookup normalises to letters and digits and prefix-matches; here tags are keyed by Card key and looked up
   exactly (section 3.5 note).

