# contracts/

Published, machine-readable contracts. Each file is **generated** by `npm run contracts:write` (builds, then
runs `scripts/write-contracts.mjs`) from `src/rules/`; never hand-edit one. `test/contracts.test.ts` fails when
a committed file differs from what the code renders, byte for byte, and names the fix.

Consumers (the website `contracts/`, the Unity `Contracts/`) copy the file **verbatim**; they never edit it and
the backend never writes into another repo. When a value changes, change it in Unity and in `src/rules/`
together, run `npm run contracts:write`, commit, and let each consumer re-copy.

## catalog.v1.json

```
{ "format": "catalog.v1",
  "modules": [{ "id", "unity", "slug", "ticket" }],              // 8, in Unity ticket order (ticket 1..8)
  "ranks":   [{ "id", "unity", "name", "statusPoints" }],        // 5, lowest first
  "trip":    { "flightsPerTrip", "maxFlightsAtOwnRank" } }
```

- `modules[].id` is the backend module id on the wire (Unity `ModuleRegistry` BackendId); `unity` is the Unity
  `ModuleId` enum name; `slug` the ModuleRegistry public slug; `ticket` the 1-based approved ticket order.
- `ranks[].id` is the kebab id on the wire; `unity` the `FlightRank` enum name; `name` the player-facing title;
  `statusPoints` the lifetime Status Points needed to be certified at that rank (trainee = 0, strictly ascending).
  **Array order is load-bearing**: index in `ranks` is the rank order (Active Rank may not exceed Certified Rank).
- `trip.flightsPerTrip` is Flights per Trip (Unity: Rounds per Flight Segment). `trip.maxFlightsAtOwnRank` is the
  first-pass own-rank cap of the commercial dealing rule; Unity's Military dealer has no such cap today.
- Format: 2-space indent, LF, one trailing newline, keys in the order shown.

### Versioning

Within `catalog.v1`, changes are **additive only** (a new field on an entry, a new top-level key); consumers
must ignore fields they do not know. Renaming or removing a field, changing an id, or reordering `ranks`
is breaking and ships as a new file `catalog.v2.json` (`format: "catalog.v2"`) beside v1. Changing a value
(e.g. a threshold) or adding a module/rank entry is a content change: regenerate and notify consumers, whose
parity tests are meant to fail until they re-copy.

## dealer.v1.json

Golden Trip decks from the backend dealer (`src/rules/dealer.ts`), so any consumer can replay each case through
its own dealer and compare. Generated from `src/rules/dealer-fixture.ts` (frozen pools, case list and renderer; it
lives under `src/` so `nest build` compiles it for `scripts/write-contracts.mjs`; `test/dealer-cases.ts` re-exports
it). The expected decks are whatever `dealTripWithPolicy` deals, never hand-written.

```
{ "format": "dealer.v1", "rng": "fnv1a32-utf16+xorshift32",
  "flightsPerTrip": 10, "maxFlightsAtOwnRank": 6,
  "modulePolicy": { "<moduleId>": "lower-ranks" | "nearest-ranks" },     // only Modules the server deals
  "pools":    { "<pool>": [{ "id", "rank", "photoKey", "answer", "wrong": [3] }] },   // array order = dealer input order
  "cases":    [{ "name", "pool", "policy", "rank", "seed",
                 "expect": { "deck": [{ "itemId", "choices": [4], "correctIndex" }] } }],
  "coverage": [{ "pool", "policy", "perRank": { "<rank>": count } }] }
```

- `rng`: seed = FNV-1a 32 over the seed string's UTF-16 code units (`h ^= unit; h = imul(h, 16777619) >>> 0`,
  offset 2166136261); that seeds xorshift32 (state 0 becomes 0x9E3779B9; `x ^= x << 13; x ^= x >>> 17; x ^= x << 5`,
  unsigned 32-bit). Shuffle is Fisher-Yates from the end with `Next(n) = u32 % n`. Consumption order: the two pick
  shuffles, the final pick shuffle, the answer slots (`i % 4`, shuffled), then one distractor shuffle per Flight.
- `policy`: `lower-ranks` = Unity `BuildDeck` (own rank up to 6, lower ranks, own-rank top-up, distinct photos);
  `nearest-ranks` = Unity `BuildMilitaryDeck` (all own rank, then nearest ranks with ties to the lower rank, higher
  ranks included, distinct photos and distinct normalized answers: letters and digits only, lower-cased).
- `pools[*]` items are already in dealer input order; deal them in that order. `rank` is the kebab id, `photoKey`
  the photo identity (Unity `ClientQuestion.PhotoId`). Pools: `military-v1` (the 30 rows Unity bundles in
  `military_questions.json`), `identifier-v1` (the 31 commercial rows in `identifier_questions.json`), and four
  synthetic ones (`thin-trainee`, `duplicate-answers`, `duplicate-photos`, `too-small`).
- `cases[*]`: the `seed` is the Unity session id (may be empty or non-ASCII). A deck can be shorter than 10 when the
  pool cannot fill it. `choices` are the four options in slots A-D.
- `coverage`: Flights a Trip holds per rank (capped at 10) for `military-v1` under both policies (`tripCoverage`,
  fixed seed `trip-coverage`).
- Format: 2-space indent, LF, one trailing newline, keys in the order shown. Versioning rules are as for the catalog.

The repo's `.gitattributes` pins `contracts/*.json` to LF so a Windows checkout (`core.autocrlf=true`) keeps the
bytes the test compares. Consumers should do the same for their vendored copy.
