# Plan: deploy Backend 0.32.0 to hosted dev (`dev.api.playairplanegames.com`)

Status: **run, 2026-11-26, by the user, as the plain deploy (dev now on 0.33.0, migration 0032).** The step 2 backup was
taken first. Public checks passed; see `docs/TASKS.md` verification log 2026-11-26 for what is and isn't recorded.
Originally asked by the user ("Plan the dev deploy"). Every server step is run by the user (root on the server, from the `server/` scripts folder); this
session has no server access and runs only the read-only public checks marked **(me)**.

## Where dev is now (read-only checks, 2026-11-26)

- `GET https://dev.api.playairplanegames.com/api/v1/health` → `{"ok":true}`.
- `GET .../api/docs/openapi.yaml` → `version: 0.30.0`. So dev runs a 0.30.0 build (Backend `62ff2bb` or a later commit
  before `80ad7bf`), not the 0.27.x that `docs/TASKS.md` 6.3 last recorded.
- `POST .../api/v1/admin/media/1/review` with no token → 401 (the 0.30.0 route exists; an unknown route is 404).
- **Expected therefore:** migrations `0000`–`0029` applied (30 rows), `0030` and `0031` pending. **Step 1 confirms this**;
  if the count is not 30, stop and re-plan (0027 needs `--stop-first` and a backup, see TASKS 6.4).

## What this deploy brings

| Version | Migration | Effect on dev |
|---|---|---|
| 0.31.0 Code Search | 0030 `trip_decks` (new table) | Additive. Dealing from items stays OFF unless `DEAL_FROM_ITEMS=code-search` is set; no board content exists on dev until `npm run demo:seed-code-search` runs. Both are **not** part of this deploy (separate sign-off) |
| 0.32.0 self-serve photographer | 0031 (audit CHECK + pending → active backfill) | Photo submission needs no approval; approve/reject → 404; 20 photos waiting per account (429 `submission_limit`). Default cap needs no env change |

**Can the backend go before the website and Admin?** Yes:
- The old website's "Request photographer access" button calls the same route; it now answers 201 `active`, so the photo form
  opens at once. Its "awaiting approval" text simply never shows. Upload over the cap shows the backend's 429 message only if
  the website passes error messages through (cosmetic).
- The old Admin's approve/reject buttons only show for `pending` rows, and 0031 leaves none with an email. A click would get 404.
- The game is unaffected (Unity does not call these routes, and does not reach `/v1/trips` yet).
- So: backend now; the website and Admin follow the brief `../docs/briefs/self-serve-photographer.md` in their own time.

**Is `--stop-first` needed?** No. Between migrate and restart the old 0.30 build keeps serving: 0030 only adds a table, 0031
only widens a CHECK and takes the role lock; a photographer request the old build makes in that gap creates a `pending` row,
which the account's next call activates (plan S2). Use it anyway if you prefer a clean cut on dev (a few seconds' outage).

## Steps (user, on the server)

1. **Confirm the migration count** (expect `30`):
   ```bash
   sudo -u postgres psql -d airplane_games_dev -Atc "select count(*) from drizzle.__drizzle_migrations"
   ```
   Also note the pending photographer requests 0031 will activate (for the record):
   ```bash
   sudo -u postgres psql -d airplane_games_dev -Atc "select count(*) filter (where request_email is not null), count(*) from account_roles where role='photographer' and state='pending'"
   ```
2. **Back up the dev database** (nothing else backs Postgres up, server/README "Not covered yet"):
   ```bash
   sudo install -d -m 0700 /var/backups/aviation-arcade
   sudo -u postgres pg_dump -Fc -d airplane_games_dev | sudo tee /var/backups/aviation-arcade/dev-$(date +%F-%H%M)-pre-0.32.dump >/dev/null
   sudo ls -l /var/backups/aviation-arcade/
   ```
3. **Deploy, pinned to the reviewed commit.** `main` moved on after this plan: another session pushed API 0.33.0 (FAQ,
   migration 0032, `c0a2b62`), which this plan did not check. A plain `sudo ./backend-deploy.sh dev` would take it too. So
   deploy the archive of `9dd181d` (0.32.0, migrations up to 0031):
   ```bash
   curl -fL -o /tmp/backend-9dd181d.zip https://github.com/karrtik-kmp/TheAviationArcade-Backend/archive/9dd181d410b2ee253ec949917268dc325e31c51a.zip
   sudo ./backend-deploy.sh dev --zip /tmp/backend-9dd181d.zip
   ```
   (The script unwraps the archive's one top-level folder.) To take 0.33.0 as well, run plain `sudo ./backend-deploy.sh dev`
   and expect **33** migrations and `0.33.0` in steps 4-5; 0032 only widens two name CHECKs, so it is additive.
   Judge the migrate step by its exit code, not the missing spinner line (TASKS 6.3).
4. **Check on the server:**
   ```bash
   sudo -u postgres psql -d airplane_games_dev -Atc "select count(*) from drizzle.__drizzle_migrations"   # expect 32 (33 with 0.33.0)
   sudo -u postgres psql -d airplane_games_dev -Atc "select action, count(*) from admin_audit where action='role_self_activate' group by 1"
   sudo -u postgres psql -d airplane_games_dev -Atc "select state, count(*) from account_roles where role='photographer' group by 1"
   curl -fsS http://127.0.0.1:3001/v1/health/ready
   apm2 logs aviation-backend-dev --lines 50 --nostream
   ```
5. **Public checks (me), no token needed:** `docs/openapi.yaml` says `0.32.0`; `POST .../photographer/approve` is 404 (was
   401); health and the guest Plane of the Day read still 200.
6. **Smoke test (user, in a browser):** on `dev.playairplanegames.com/contribute` with a verified test account that is not a
   photographer: the request button turns submission on at once and a photo uploads (`unverified`). On `dev.admin`: the photo
   shows on the Media desk and can be published; Users and roles still lists and blocks.
7. **Military on `/v1` (for Unity, MG-MOD-08):** needs a signed-in player's Firebase ID token on `airplane-games-9fe1e`, which
   only the user can obtain. Either the user runs the three calls below with a test account's token, or this check waits for
   Unity's `/v1/trips` client (ADR-0008 S5):
   ```powershell
   $h = @{ Authorization = "Bearer <ID token>" }   # a test player's token; never commit or paste it into a doc
   $base = "https://dev.api.playairplanegames.com/api"
   Invoke-RestMethod -Method Put  "$base/v1/me" -Headers $h -ContentType "application/json" -Body "{}"
   $h["Idempotency-Key"] = [guid]::NewGuid().ToString("N")
   Invoke-RestMethod -Method Post "$base/v1/trips" -Headers $h -ContentType "application/json" -Body '{"module":"aircraft-identifier-military","flightCount":10,"localDate":"2026-11-26","utcOffsetMinutes":0,"contentVersion":"<from GET /v1/content/manifest>"}'
   ```
   (`OpenFlightSegmentRequest` in `docs/openapi.yaml`; add `X-Client-Version` if dev sets a minimum build. A 201 with
   Rounds to play answers MG-MOD-08 for dev; dev needs approved Military items, which the demo seed loaded.)

## Rollback

- A failed migrate rolls back as a whole; the old build keeps serving. Fix and redeploy.
- After a successful migrate the 0.30 build still runs on the new schema (both changes are additive), so rolling the code back
  is `sudo ./backend-deploy.sh dev --zip /var/lib/aviation-arcade/releases/<previous backend-dev zip>`. Approve/reject would
  then work again on the activated rows; harmless on dev.
- Full restore: `pg_restore --clean --if-exists -d airplane_games_dev <step 2 dump>` with the backend stopped, then the old zip.

## After the deploy (me)

- Record the result in `docs/TASKS.md` (6.3 deploy log; 6.4–6.8 "applied to hosted dev") with the step 1 and 4 numbers.
- Tell the website and Admin sessions that dev runs 0.32.0, and Unity the Military result (or that it waits for S5).
- Not in this deploy: `DEAL_FROM_ITEMS=code-search` and the Code Search seed on dev; production (`api.`) entirely.
