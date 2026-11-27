# Plan: deploy Backend 0.35.0 to hosted dev (`dev.api.playairplanegames.com`)

Status: **ready, 2026-11-27. Waiting for the user's sign-off.** This session has no server access, so every server step is the
user's, run as root from the `server/` scripts folder. The public checks marked **(me)** are mine.

## What this deploy brings

- `696fe9e`: Sign in with Apple. `apple.com` ID tokens are accounts.
- `d224124`: Firebase session cookies from the website on nine routes, with the backend checking revocation
  (`docs/plans/session-cookies.md`).
- **No migration** (still 34, `0000`–`0033`). **No new env setting.**
- Session cookies need `FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE`, the key that admin grants already use. Without it, every session
  cookie answers 503 `auth_unavailable`. ID tokens and the game are not affected either way.

## Steps (user, on the server, as root)

1. Check that the admin key is configured on dev. Expect one line naming a file that exists:
   ```bash
   F=/var/www/dev.api.playairplanegames.com/envVar/.env
   grep -E '^FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE=' "$F" && sudo ls -l "$(grep -E '^FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE=' "$F" | cut -d= -f2-)"
   ```
   If it is missing, install the `backend-grant` key first (`server/README.md` "Firebase admin key"). Its role
   `roles/firebaseauth.admin` includes `firebaseauth.users.get`, which the revocation check needs.
2. Deploy, pinned to the reviewed commit `d224124`:
   ```bash
   curl -fL -o /tmp/backend-d224124.zip https://github.com/karrtik-kmp/TheAviationArcade-Backend/archive/d224124f2f313ed61c003dfb429d97ef19d51d64.zip
   sudo ./backend-deploy.sh dev --zip /tmp/backend-d224124.zip
   ```
   With no migration pending, the migrate step should apply nothing. Judge it by its exit code.
3. Check on the server:
   ```bash
   sudo -u postgres psql -d airplane_games_dev -Atc "select count(*) from drizzle.__drizzle_migrations"   # expect 34
   curl -fsS http://127.0.0.1:3001/v1/health/ready
   ```
   In the pm2 log, a `FirebaseAccounts`/`SessionRevocation` error at start means step 1 failed.
4. **Public checks (me):**
   - openapi says `0.35.0`;
   - health is 200;
   - `GET /api/v1/me/roles` with an unsigned token is 401;
   - a game ID-token route with no token is still 401.
5. **Cookie check (later, by the website on dev, after Josh's demo):** a real session cookie on `GET /v1/me/roles` is 200,
   and the same cookie on `PUT /v1/me` is 401. This also confirms the unverified facts in the plan: the real cookie claims,
   the X.509 key map and `validSince`.

## Rollback

`sudo ./backend-deploy.sh dev --zip /var/lib/aviation-arcade/releases/<previous backend-dev zip>`. There is no schema change,
so 0.34 runs as before. The website must not be using session cookies when this is rolled back: the website rolls back first.

## Not in this deploy

Production (`api.`), and any website change (the website still sends ID tokens until its S3 switch).
