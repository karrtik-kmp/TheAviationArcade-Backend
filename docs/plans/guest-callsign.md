# Plan: server-backed guests and Callsigns, API 0.34.0

Status: **implemented (local) 2026-11-26** on branch `claude/determined-murdock-2cfda7` (TASKS 6.10).

**Plan gate done 2026-11-26.** Senior-lead and backend-expert both answered "approve with changes", and the changes are
folded in below. The changes:
- PlayerBalance owns every `players` write.
- A linked `anonymous` token is accepted whatever the flag says.
- Only `email` and `google.com` identities count as linked.
- Startup is refused in production when guests are on without `TRUST_PROXY`.
- The claim maps database errors explicitly.
- The first change is free.
- `changeableAt` gets a declared error schema.
- Tests carry `ASSUMPTION:` names.

**Source:** the Unity S4/S5 orchestrator's brief (2026-11-26), from the user rulings of 2026-11-26 (Unity ADR-0006
amendment):
1. Every launch starts as a Firebase Anonymous guest, and a guest is a real Backend player.
2. Every player picks a Callsign, which the Backend validates and saves on the player.
3. Settings links the guest to email/password or Google, and the link keeps the uid.
4. A link clash is blocked in the app. There is no server merge.
5. Guests cannot buy.
6. Firebase project `airplane-games-9fe1e` is dev only.

Builds on 0.33.0 (`cf2d3ba`). One migration (**0033**), API **0.34.0**.

## Decisions

**G1. Guest test** (`src/auth/firebase.ts`, `guestFor`):

| Token | Result |
|---|---|
| `password` or `google.com` | An account, as before |
| `anonymous` whose `firebase.identities` holds `email` or `google.com` as a non-empty array of strings | A **linked account**, accepted whatever the flag says |
| Any other `anonymous` token, including other identity keys such as `phone`, empty lists, or no `identities` | A **guest**, accepted only with `FIREBASE_ANONYMOUS_PLAYERS=true`, otherwise 401 |
| `anonymous` with malformed `identities` | 401 |
| Any other provider | 401 |

- Why linked tokens ignore the flag: Firebase documents nothing about what `linkWithCredential` does to
  `sign_in_provider` (research note, 2026-11-26). Accepting them also means switching the flag off never locks out linked
  players.
- `FirebaseIdentity.anonymous` becomes `req.anonymous`.
- The flag takes `true` or `false` exactly, defaults to `false`, and is allowed in every APP_ENV, because hosted dev runs
  `APP_ENV=production`.

**G2. `players.anonymous_since`.**
- `PlayerBalance.open(..., { anonymous })` stamps it on a new row only.
- `PlayerBalance.clearGuest` clears it on the first account `PUT /v1/me`.
- Neither write bumps `version`, `logbook_version` or `updated_at`, and neither queues a mirror (invariant 13).
- A stale guest token never stamps the row again.

**G3. Per-IP limit on new guests.**
- When an anonymous `PUT /v1/me` finds no row, it counts `guest-create:ip:<bucket>` in the shared ThrottlerStorage, then
  creates the player.
- The limiter has its own throttler name `guest-create`, so it uses its own rows and refusal cache.
- The window is 1 h. **ASSUMPTION:** the default limit is 20 (`GUEST_CREATE_PER_IP_PER_HOUR`, 1 to 100,000).
- Over the limit: 429 `rate_limited` with `Retry-After`, and no player or role row is written.
- Bucketing: IPv4 is used as is. IPv4-mapped IPv6 counts as the IPv4 address. Other IPv6 counts as its /64. A zone id is
  dropped. An unparseable or missing address goes to one shared bucket.
- `APP_ENV=production` with guests on and `TRUST_PROXY` unset refuses to start. Without it, every guest would share the
  proxy's address.
- Two concurrent first calls of one guest may count twice. That is accepted.

**G4. `@AccountRequired()`, 403 `account_required`.**
- The guard runs after the rate limit and before RolesGuard. It fails closed when `req.anonymous` is unset.
- It covers three routes:
  - `POST /v1/purchases`.
  - `POST /v1/shop/miles-hint-pack`. **ASSUMPTION:** spending Miles counts as buying. It was named in the brief and is open
    for the user.
  - `POST /v1/me/roles/photographer`.
- `RolesService.authorize` also refuses guests (403 `forbidden`) as defence in depth.
- Reads stay open to guests: entitlements, own roles, progress, Trips, Rounds and the Logbook.
- Guests still get the informational `player` role row at signup (ADR-0002: `player` at signup). It grants nothing, and
  the admin role desk lists only photographer and admin requests.

**G5. UGS.** No change. The research found that the UGS OIDC docs say nothing about required claims or the external id. The
link keeps the uid, which is what A3 matched as `externalId`. See ARCHITECTURE "Guests and Callsigns". Not tested live.

**C1. Callsigns on `players`.**

The columns:
- `callsign`: UNIQUE `players_callsign_unique`, with the CHECK `^[A-Z0-9]{3,16}$`. Because only upper case is stored, the
  index is case-insensitive in effect.
- `callsign_claimed_at`: NULL exactly when `callsign` is.
- `callsign_changed_at`: NULL until the first change.

Writes go only through `PlayerBalance.setCallsign` (invariant 14). It locks the row first, then runs one UPDATE. There is no
version bump and no mirror.

Rules:
- **Format:** trim, then 3 to 16 ASCII letters or digits, then upper case. This deliberately differs from Unity's
  `Trim().ToUpperInvariant()`-then-regex: `ı`, `ſ` and `ß` are invalid here. The raw value is capped at 64 characters.
- **ASSUMPTION, reserved names:** `ADMIN`, `ADMINISTRATOR`, `MODERATOR`, `STAFF`, `SUPPORT`, `SYSTEM`, `OFFICIAL`, `PILOT`,
  `GUEST`, matched exactly. A client profanity list is an open question.
- **ASSUMPTION, change policy:** the first claim is free and the first change is free (a typo at onboarding). After that,
  one change per 30 days since the last change, on the database clock. Re-claiming the value already held is a no-op.

Routes:
- `GET /v1/callsigns/{value}/availability` answers 200 `{ value, normalized, available, status }`, where `status` is one of
  `available | yours | taken | reserved | invalid`.
- `POST /v1/callsigns/claim` takes `{ callsign }` (strict, so the old `deviceId` is 400). It answers 200
  `{ callsign, claimedAt, changed }`. Errors:
  - 404 `player_not_found`.
  - 422 `callsign_invalid`.
  - 409 `callsign_taken`: taken, reserved, a lost race (23505 on `players_callsign_unique`), or a lost swap deadlock (40P01).
  - 409 `callsign_change_too_soon`, with the body `CallsignChangeTooSoon` `{ error, changeableAt }`.
- `PUT /v1/me` answers `SignInEnvelope` `{ progress, profile: { callsign, guest } }`. This is BREAKING for a strict reader
  of that one response. `ProgressEnvelope` and `Progress` are unchanged.

**Accepted risk:** abandoned guests hold their Callsigns. Up to 20 new guests per IP per hour could squat names. Clean-up is
a follow-up.

## Deploy note (hosted dev, needs the user's sign-off)

1. **Code:** merge this branch to `main`, then deploy as usual. Hosted dev runs 0.33.0 with migrations up to 0032, so the
   only new migration is **0033**:
   - 4 nullable columns without defaults, 1 unique index over an all-NULL column, and 3 CHECKs.
   - `lock_timeout` 5 s.
   - Expected migration count: 33 → 34.
2. **Dev env file** (`envVar/.env` of `aviation-backend-dev`):
   - `FIREBASE_ANONYMOUS_PLAYERS=true`.
   - `TRUST_PROXY=1` must already be set (`server/backend.env.example:10`). The server refuses to start without it.
   - `GUEST_CREATE_PER_IP_PER_HOUR` unset, so the default is 20.
   - Then run `pm2 restart aviation-backend-dev --update-env`.
3. **Production env file:** leave both settings unset.
4. **Firebase console (the user):** enable the Anonymous provider in `airplane-games-9fe1e`. Linking email to an anonymous user
   can fail while email-enumeration protection is on (firebase-js-sdk #7675), so check it there. Then confirm the **ASSUMPTION** in
   G1 on real tokens:
   - Decode a guest's ID token before and after linking, for email/password, for Google and for Apple. Record `sign_in_provider`,
     `identities`, `email` and `email_verified`.
   - Check that an anonymous user cannot gain `identities.email` without linking an email credential. If it can, count `email`
     only with `email_verified` (code review, 2026-11-26).
5. **Smoke test:**
   - `/api/docs/openapi.yaml` reads `version: 0.34.0`.
   - `GET /api/v1/callsigns/ABCD/availability` with no token is 401.
   - In the app, a guest's `PUT /v1/me` is 201 with `profile.guest: true`.
6. **Rollback:** set the flag to false and restart. Guests then get 401, linked accounts keep working, and the columns stay,
   because they are additive.

## Not in scope

- A server merge.
- Clean-up of abandoned guests and their Callsigns.
- Leaderboards and showing Callsigns to other players.
- The website, which still refuses `anonymous` tokens. Its verifier would also refuse a linked token that still names
  `anonymous`. Message the website session.
- The root `CLAUDE.md`, `docs/PROJECT_STATE.md` and SRS OI-07 still say "no guest play". These are outside this repo: message
  the root session.
