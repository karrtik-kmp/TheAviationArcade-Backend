# Firebase admin access (the admin grant marks emails verified)

Since API 0.28.0 (ADR-0002 follow-up, user rulings 2026-11-19), granting `admin` — in the Admin's Users desk
(`POST /v1/admin/accounts/{principal}/roles/admin/grant`) and with `npm run roles:grant` — first sets the account's Firebase
`emailVerified` to true. Staff needs a verified email, and the client's editors are email/password accounts that the Admin never
verifies. The backend acts only on the uid of a principal of its own `FIREBASE_PROJECT_ID`, never by email.

Without this access the backend still starts (it logs a warning), but **every admin grant answers 503** and `roles:grant` refuses
(exit 2). Signing in with Google keeps working without it, because Google accounts are already verified.

## What each backend needs

| Backend | Setting | Value |
|---|---|---|
| prod (`api.playairplanegames.com`) | `FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE` | `/var/www/api.playairplanegames.com/envVar/firebase-admin.json` |
| dev (`dev.api.playairplanegames.com`) | `FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE` | `/var/www/dev.api.playairplanegames.com/envVar/firebase-admin.json` |
| local / tests (`demo-airplane-games`) | `FIREBASE_AUTH_EMULATOR_HOST` | `127.0.0.1:9199` (`npm run auth:emulator`); the e2e suite starts it itself |

Both hosted backends use the same Firebase project (`airplane-games-9fe1e`), so they may share one key. Two keys (one per backend)
let you revoke one without touching the other; either is fine.

The key file must be a service-account JSON key whose `project_id` is `airplane-games-9fe1e` (any other project is refused at
start). It is read like the store keys: outside the code folder, never committed, never logged. A `demo-` project refuses the key;
`FIREBASE_AUTH_EMULATOR_HOST` is refused in production, with a real project and with any non-loopback host.

## Owner steps (Google Cloud console, project `airplane-games-9fe1e`)

1. IAM & Admin → Service accounts → Create service account, for example `backend-grant`. No other access.
2. Grant it the role **Firebase Authentication Admin** (`roles/firebaseauth.admin`). It carries `firebaseauth.users.get` and
   `firebaseauth.users.update`, which the backend uses (Identity Toolkit `accounts:lookup` and `accounts:update`, OAuth scope
   `cloud-platform`).
3. Keys → Add key → JSON. Download it once; it is the secret.

## Server steps (per backend; root on the Hostinger server)

```bash
sudo install -o root -g aviation -m 0640 firebase-admin.json /var/www/api.playairplanegames.com/envVar/firebase-admin.json
sudo nano /var/www/api.playairplanegames.com/envVar/.env
#   FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE=/var/www/api.playairplanegames.com/envVar/firebase-admin.json
apm2 restart aviation-backend-prod   # pm2 rereads .env on restart; the apm2 alias is in ../server/README.md "Releases"
```

Repeat with `dev.api.playairplanegames.com` and `aviation-backend-dev` for dev. The same steps are in `../server/README.md`
("Firebase admin key") and the commented setting in `../server/backend.env.example`. Delete the downloaded copy afterwards. The server logs no
"Firebase admin access is not configured" warning once it is set; a key that does not import stops the start with an error that
names the setting only.

## Checking it

Grant `admin` to a test editor (email/password, unverified) in the dev Admin. The answer says `emailVerification: "verified"`;
the person signs out and in again and the Admin opens. A 503 whose message says Firebase "could not mark the account's email
verified" means the key or its role is wrong: the backend log names the call and Google's error code (never the key).

## Trade-off (ADR-0002)

Firebase then treats that address as proven for the whole project (password resets, provider linking), so the granting admin must
know who owns the account. A typed email at grant must match the account's own sign-in email (409 `account_email_mismatch`
otherwise). Revoking admin later does not un-verify the email.
