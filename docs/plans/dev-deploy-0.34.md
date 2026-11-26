# Plan: deploy Backend 0.34.0 to hosted dev (`dev.api.playairplanegames.com`)

Status: **ready, 2026-11-26.** The user asked: "deploy it to hosted dev". This session has no server access (root SSH refuses
its key), so every server step is the user's, run as root from the `server/` scripts folder. The public checks marked
**(me)** are mine.

## Where dev is now (public checks, 2026-11-26)

- `GET /api/v1/health` → `{"ok":true}`.
- `/api/docs/openapi.yaml` → `version: 0.33.0`.
- `GET /api/v1/callsigns/ABCD/availability` → 404 (the route does not exist yet).

**Expected:** 33 migrations applied (`0000` to `0032`). **0033 is the only one pending.**

## What this deploy brings

0.34.0 adds guests and Callsigns: `e28c1c1` and `8a8e867` on `main`. The plan is `docs/plans/guest-callsign.md`.

**Migration 0033:**
- 4 nullable `players` columns with no default.
- 1 unique index over an all-NULL column.
- 3 CHECKs.
- `lock_timeout` 5 s.

**`--stop-first` is not needed.** The 0.33 build keeps serving between the migrate and the restart. Drizzle names its columns,
so the new ones are ignored.

**New env setting:**
- `FIREBASE_ANONYMOUS_PLAYERS=true`, for dev only.
- The server refuses to start with it on unless `TRUST_PROXY` is set. It is `1` in `server/backend.env.example`.
- Add it **before** deploying, so the deploy's one restart picks it up.

## Steps (user, on the server, as root)

1. Confirm the migration count. Expect `33`:
   ```bash
   sudo -u postgres psql -d airplane_games_dev -Atc "select count(*) from drizzle.__drizzle_migrations"
   ```
2. Back up the database:
   ```bash
   sudo install -d -m 0700 /var/backups/aviation-arcade
   sudo -u postgres pg_dump -Fc -d airplane_games_dev | sudo tee /var/backups/aviation-arcade/dev-$(date +%F-%H%M)-pre-0.34.dump >/dev/null
   sudo ls -l /var/backups/aviation-arcade/
   ```
3. Turn guests on in the dev env file, and check that `TRUST_PROXY` is set:
   ```bash
   F=/var/www/dev.api.playairplanegames.com/envVar/.env
   grep -c '^FIREBASE_ANONYMOUS_PLAYERS=' "$F" || echo 'FIREBASE_ANONYMOUS_PLAYERS=true' | sudo tee -a "$F" >/dev/null
   grep -E '^(FIREBASE_ANONYMOUS_PLAYERS|TRUST_PROXY)=' "$F"     # expect both lines: =true and =1
   ```
4. Deploy, pinned to the reviewed commit `8a8e867`:
   ```bash
   curl -fL -o /tmp/backend-8a8e867.zip https://github.com/karrtik-kmp/TheAviationArcade-Backend/archive/8a8e86790ccc1fa3a526bad14d580374d0859346.zip
   sudo ./backend-deploy.sh dev --zip /tmp/backend-8a8e867.zip
   ```
   Judge the migrate step by its exit code, not by the missing spinner line (TASKS 6.3).
5. Check on the server:
   ```bash
   sudo -u postgres psql -d airplane_games_dev -Atc "select count(*) from drizzle.__drizzle_migrations"   # expect 34
   sudo -u postgres psql -d airplane_games_dev -Atc "select count(*) from players where callsign is not null or anonymous_since is not null"   # expect 0
   curl -fsS http://127.0.0.1:3001/v1/health/ready
   ```
   Check the pm2 log as well. A `needs TRUST_PROXY` error means step 3 was skipped.
6. **Firebase console (user):** in `airplane-games-9fe1e`, go to Authentication → Sign-in method and enable **Anonymous**.
   While you are there, check whether email-enumeration protection is on. It can block linking an email to a guest
   (firebase-js-sdk #7675).
7. **Public checks (me):**
   - openapi says `0.34.0`.
   - `GET /api/v1/callsigns/ABCD/availability` with no token is 401 (it was 404).
   - Health is 200.
8. **Token check (user, or Unity on a device):** this confirms the G1 ASSUMPTION in `guest-callsign.md`.
   - With a guest token, `PUT /api/v1/me` is 201 with `profile.guest: true`.
   - After linking, `PUT` again is 200 with `guest: false`.
   - Decode both ID tokens. Record `sign_in_provider` and `identities`, and never paste a token into a doc.

## Rollback

- To switch guests off: remove the line (or set `=false`) and run `pm2 restart aviation-backend-dev --update-env`.
  Guests then get 401, and linked accounts keep working.
- To roll the code back: `sudo ./backend-deploy.sh dev --zip /var/lib/aviation-arcade/releases/<previous backend-dev zip>`.
  The 0.33 build runs on the 0033 schema.
- Full restore: `pg_restore --clean --if-exists -d airplane_games_dev <step 2 dump>` with the backend stopped.

## Not in this deploy

- Production (`api.`).
- `DEAL_FROM_ITEMS`.
- Any website change: the website still refuses guests.
