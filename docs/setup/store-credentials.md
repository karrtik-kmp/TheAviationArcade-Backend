# Store credentials: what the owner sets up for Apple and Google

For: the account owner (Apple Developer Account Holder / Admin, Google Play Console owner). These steps happen in Apple's and
Google's consoles and only the owner can do them. Nothing here is a backend command. The backend reads the results from
environment variables (plan `docs/plans/purchases.md`, waves P2 and P3).

App identifiers (from the Unity project, `ProjectSettings.asset`): iOS bundle id **`com.airplane.games`**, Android package name
**`com.airplane.games`**.

**Secrets never go into git, chat, tickets or email.** The Apple `.p8` key and the Google JSON key are files: keep them in a
folder outside every repo (for example `H:\secrets\airplane-games\`) and tell the backend only their **paths** and the non-secret
ids below. Both keys can be revoked and re-issued in the console if one ever leaks.

**Product ids are permanent in both stores.** Once saved, a product id cannot be renamed and cannot be reused even after the
product is deleted. The ids below are placeholders until the client supplies final ones (Unity Q4): **do not create the
products (Apple step 3, Google step 4) until the ids are final**, unless you decide these ids are final. Every other step is safe
now.

Sources (checked 2026-11-05): Apple help "Generate keys for In-App Purchases", "Create a Sandbox Apple Account", "Sign and update
agreements", "Enter server URLs for App Store Server Notifications"; Google "Getting started" (Android Publisher API), "Getting
ready" (Play Billing, RTDN), "Authenticate push subscriptions" (Pub/Sub). Console menus move; if a label differs, the step is
the same.

## Apple (App Store Connect)

1. **Agreements.** Business → Agreements: the Account Holder signs the **Paid Apps Agreement** with banking and tax details.
   Sandbox purchases and new In-App Purchases do not work until it is active.
2. **App record.** Apps → the app with bundle id `com.airplane.games` (create it if missing). App Information → note the
   numeric **Apple ID** (also in the App Store URL). Needed only for production verification.
3. **Products (only with final ids; see the warning above).** In the app: Monetization → In-App Purchases: create four **Consumable** products with the ids the backend catalog
   uses (today the placeholders `aa.hints.5`, `aa.hints.15`, `aa.miles.5000`, `aa.miles.25000`). Monetization → Subscriptions:
   create one **subscription group** (for example "First Class") with two auto-renewable subscriptions `aa.firstclass.monthly`
   (1 month) and `aa.firstclass.yearly` (1 year). Prices are yours to set; the backend holds none. If the final ids differ from
   the placeholders, send the list: staff add them to the catalog (they are data, not code).
4. **In-App Purchase key.** Users and Access → Integrations → In-App Purchase → Generate In-App Purchase Key (or +). Name it
   "airplane-games backend". Download the **`.p8` file (only possible once)** and save it in the secrets folder. Note the **Key
   ID** shown next to the key and the **Issuer ID** (shown at the top of the Keys page; if not on the In-App Purchase tab, look on
   the App Store Connect API tab; verify). Keep a second copy of the `.p8` in a password manager: it cannot be downloaded again (a
   lost key is not fatal: generate a new one and redeploy).
5. **Sandbox testers.** Users and Access → Sandbox → Test Accounts → +. Use an email that is not already an Apple Account (an
   alias works). On the test iPhone the sandbox account is under Settings → Developer → Sandbox Apple Account (or Settings → App Store on older
   iOS; verify); it appears after a development or TestFlight build first tries a purchase. Never sign in to iCloud with it. Sandbox purchases are free.
6. **Server notifications (later, P4).** App Information → App Store Server Notifications: Version 2, a Production URL and a
   Sandbox URL. This needs a public HTTPS address for the backend, which does not exist yet: skip this step for now.

**Send to the backend session:** Key ID, Issuer ID, the numeric Apple ID, and the path of the `.p8` file. Not the file itself.

## Google (Google Cloud + Play Console)

1. **Cloud project.** console.cloud.google.com: create a **separate project for Play** (for example
   `airplane-games-play`), recommended over the Firebase auth project `airplane-games-auth-20261022` so a key-carrying service
   account never sits next to production auth. If you use the Firebase project anyway, give this account no IAM roles. Pub/Sub
   may need billing enabled. An organization policy (`iam.disableServiceAccountKeyCreation`, default on for organizations
   created since 2024) can block key download, and `iam.allowedPolicyMemberDomains` can block the Play grant in step 6; personal
   projects without an organization are not affected. APIs & Services → enable **Google Play Android Developer API**.
2. **Service account.** IAM & Admin → Service Accounts → Create (name "play-purchases"). No Cloud roles are needed for purchase
   checks. Keys → Add key → JSON: save the file in the secrets folder. Note the service account **email**.
3. **Play Console access.** Play Console → Users and permissions → Invite new user → the service account email → app permissions
   for this app: **View financial data, orders, and cancellation survey responses** and **Manage orders and subscriptions**.
   Allow up to a day for the invite to take effect (permission errors in the first hours are normal).
4. **Products (only with final ids; see the warning above).** Play Console → the app → Monetize with Play → Products: **In-app products** with the consumable ids above, and
   **Subscriptions** `aa.firstclass.monthly` and `aa.firstclass.yearly` (each with one base plan). Leave multi-quantity purchases off. The app must have been uploaded
   to a testing track at least once before products can be created.
5. **Testers.** Play Console → Settings → License testing: add the Google accounts of testers (their purchases are test
   purchases and are not charged). Testers install the app from the internal testing track.
6. **Real-time developer notifications (topic now, push later).** In the Cloud project: Pub/Sub → Topics → Create topic (for
   example `play-rtdn`). On the topic → Permissions → add principal `google-play-developer-notifications@system.gserviceaccount.com`
   with role **Pub/Sub Publisher**. Play Console → Monetize with Play → Monetization setup → Real-time developer notifications:
   enable, topic `projects/<project-id>/topics/play-rtdn`, choose **all notifications for subscriptions and one-time products**,
   then **Send test message**. The push subscription to the backend needs the public HTTPS address (P4): do not create it yet. A topic without a
   subscription discards its messages (the test message too): notifications before P4 are lost, and P4 recovers refunds through
   the Voided Purchases API. Optional: add a pull subscription now so P4 can read the last 7 days.

**Send to the backend session:** the project id, the service account email, the path of the JSON key file, and the topic name.

## Status (2026-11-06)

- Product ids above declared **final** by the user (2026-11-06).
- Google: Cloud project `airplane-games-9fe1e` (separate from the Firebase auth project), service account
  `airplane-games-play-ac@airplane-games-9fe1e.iam.gserviceaccount.com`, JSON key kept locally at `Backend/secrets/play-service-account.json`
  (git- and docker-ignored; the backend refuses a key path inside the repo, so enabling `STORE_VERIFIER=stores` needs a path outside
  the repo or the inline form). Play Android Developer API enabled; Play Console invite sent 2026-11-06.
- Credential check (2026-11-06, read-only, a made-up purchase token): token exchange 200; Play API 401 `permissionDenied`
  while the Play invite propagates. Done when the check answers 404 for the made-up token. RTDN topic `projects/airplane-games-9fe1e/topics/Airplane-Games-IAP-Playstore` created 2026-11-06 (P4 subscribes to it; no push
  subscription yet). Products, testers: not yet.
- Apple: not started.

**Checking the keys (`stores:check`).** Read-only; prints statuses and reasons, never a key or token; run only with the owner's
sign-off. Locally (PowerShell, in `Backend/`, real Firebase project inline for this run only):
`$env:FIREBASE_PROJECT_ID="airplane-games-auth-20261022"; $env:GOOGLE_PLAY_PACKAGE_NAME="com.airplane.games";
$env:GOOGLE_PLAY_SERVICE_ACCOUNT_FILE="H:/Work/TheAviationArcade/Backend/secrets/play-service-account.json"; npm run stores:check`
(then remove the three variables). On the dev server, as the app user, without a build and before editing the env file: see
`docs/plans/purchases.md` wave P-K, K4 step 2. Exit 0 = every configured store passed; a WARN names a missing or mistyped product.

## What the backend does with them

| Value | Environment variable (planned) |
|---|---|
| iOS bundle id | `APPLE_BUNDLE_ID=com.airplane.games` |
| Key ID / Issuer ID | `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID` |
| `.p8` path | `APPLE_IAP_KEY_FILE` |
| numeric Apple ID | `APPLE_APP_APPLE_ID` (required whenever Apple is set) |
| stores live in production | `STORE_ENABLED=apple,google` (production only) |
| Android package | `GOOGLE_PLAY_PACKAGE_NAME=com.airplane.games` |
| JSON key path | `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE` |
| RTDN topic | recorded for P4; the backend does not read it |

Each key can also be given inline instead of as a file (`APPLE_IAP_KEY`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`) for a host that
only offers environment variables; set one form, not both. In `.env` use forward slashes in paths (`H:/secrets/...`). A mounted
key file must be readable by the container user `node` (mode 0400). Rotation: Apple: issue a new key, deploy it with its Key ID,
then revoke the old one; Google: add a second key, deploy, then delete the old one.

They go in the backend's local `.env` (never committed) or the host's secret store when the backend is hosted. With them set,
`STORE_VERIFIER=stores` turns the real checks on; until then purchases answer 503 `store_unavailable` and the app keeps them
pending, as today.
