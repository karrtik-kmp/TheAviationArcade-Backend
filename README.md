# Airplane Games — game backend

The server the mobile app (Unity, `C:\Unity\Projects\AviationArcade`) calls for player identity and
progress. A standalone Node server — **NestJS + PostgreSQL (Drizzle)** — verifying Firebase ID tokens from
the same Firebase project the website (`../website`) uses, so a player is one principal across app,
website and backend. Deployed separately from the website. Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

This slice covers **player identity and progress** only. Content delivery, purchases, Flight Segment
bonuses, leaderboards and the community forum are later slices — see [docs/TASKS.md](docs/TASKS.md).

## Setup

Node >= 22.13 (24 preferred), Docker Desktop running. Run everything from this directory.

```sh
npm ci                        # install the locked dependencies
cp .env.example .env          # once; local-only values, git-ignored
docker compose up -d          # Postgres 18 on 127.0.0.1:5433 (dev db + airplane_games_test)
npm run db:migrate            # apply drizzle/ migrations to the dev database
```

Host port is **5433** because 5432 is often taken by another local Postgres.

## Commands

```sh
npm run start:dev             # watch mode, http://127.0.0.1:3000
npm run build && npm start    # compiled server (dist/main.js)
npm run typecheck             # tsc --noEmit
npm test                      # unit tests: rules + token verification (no database)
npm run test:e2e              # API tests against airplane_games_test (refuses any db not ending _test)
npm run db:generate           # new migration from src/db/schema.ts (never edit an applied one)
```

`.env` points at `demo-airplane-games` and accepts unsigned Firebase Auth Emulator tokens. Start the
emulator from the website repo (`npm run auth:emulator` in `../website`, port 9099) and sign in there to
mint tokens. Emulator tokens are honoured only for exactly `demo-airplane-games`; the production project
can never accept them.

Hosting is not chosen yet; production needs a managed Postgres, `DATABASE_URL`, and
`FIREBASE_PROJECT_ID=airplane-games-auth-20261022` with `ALLOW_EMULATOR_TOKENS` unset.

## API

All endpoints except health need `Authorization: Bearer <Firebase ID token>`. Errors are
`{ "error": { "code", "message", "requestId" } }`; every response carries `X-Request-Id`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/health` | Liveness, public |
| PUT | `/v1/me` | Sign-in handshake. Creates the player on first call (201), else 200. Returns progress |
| GET | `/v1/me/progress` | Progress. 404 `player_not_found` until `PUT /v1/me` |
| PUT | `/v1/me/active-rank` | `{ rank }`. Dial Active Rank down (Pleasure Cruise) or back to Certified. 403 above Certified |
| POST | `/v1/rounds` | `{ module }`. Issues a single-use Round; abandons any other open Round |
| POST | `/v1/rounds/:id/result` | `{ finished, errorCount, usedHint, timeRemainingFraction }`. Scores and banks it |

Result status codes: 200 banked (or `replayed: true` for a Round already banked — safe to retry),
404 not this player's Round, 410 expired or abandoned, 429 submitted too soon after issue (retry after
`Retry-After`), 503 `auth_unavailable` when Google's signing keys cannot be fetched. Unknown routes are
404 `not_found`; malformed or extra-field bodies are 400 `invalid_request`.

Ranks and module IDs on the wire are kebab-case: `trainee`, `first-officer`, `captain`, `check-airman`,
`chief-pilot`; modules follow the Unity ModuleRegistry and website catalog (`atc-match`, `identifier`,
`military-identifier`, …) — see `src/rules/`.

## Design rules

- **Identity.** The principal is `firebase:<projectId>:<uid>`, taken only from a verified token. Email
  and password and Google are the only accepted providers. No email, display name or Callsign is
  stored here; the Callsign/game-identity contract is a later, separate decision.
- **The server is authoritative for the economy.** The client reports only what happened in a Round.
  Perfect Streak, First Class Pass and Pleasure Cruise are decided server-side, and request bodies are
  strict, so extra fields are rejected.
- **Bank once, never lose a write.** A Round closes and the player is credited in one Postgres
  transaction that first locks the player row (`SELECT … FOR UPDATE`), then the Round. Lock order is
  always player → Round. Every balance change bumps `players.version`.
- **Rules mirror Unity.** `src/rules/` ports `ScoreCalculator`, `FlightRank` and `PilotProgression`.
  Change both together. Test names match the Unity tests.
- **Spec ambiguities are asserted, not buried** (Unity ADR-0004). Each is a test named `ASSUMPTION: …`.

## Known limitations of this slice

Results are client-reported. Server-issued single-use Rounds, one open Round per player, a minimum
Round duration and server-side streak/multiplier logic bound the damage, but a modified client can still
report perfect play. Checking answers server-side arrives with the content-release slice. Token
revocation is not checked: a disabled account's token works until it expires (about an hour).

## Open questions for Josh

Asserted in code and tests until ruled:

1. Chief Pilot threshold: **200,000 SP** used (spec also says 400,000).
2. Speed bonus additive with completion award (spec's worked example implies it).
3. Pleasure Cruise cap applied before the First Class multiplier.
4. Unfinished Round pays nothing and breaks the streak (Unity prototype ruling).
5. Streak Miles pay on the streak carried *into* a Round, even if that Round breaks it (matches Unity).
6. Does a hint break the Perfect Streak? Server says yes (a hinted Round is not a Perfect Completion);
   Unity's `AtcMatchScreen` currently advances the streak on zero errors alone.
7. Minimum Round duration is a provisional 3 s; needs per-module/per-rank timer lengths.
