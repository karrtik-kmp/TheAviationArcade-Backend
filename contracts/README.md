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

The repo's `.gitattributes` pins `contracts/*.json` to LF so a Windows checkout (`core.autocrlf=true`) keeps the
bytes the test compares. Consumers should do the same for their vendored copy.
