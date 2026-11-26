# Plan: self-serve photographer role (no approval to submit photos), API 0.32.0

Status: **implemented (local) 2026-11-26** (TASKS 6.8); **plan gate done 2026-11-26** (senior-lead and backend-expert, both "approve with changes", folded in below).
Cap number: **20** (user, 2026-11-26). User ruling 2026-11-26: "for the photo submission section can we make it so
they just have to register on the site, no special request/approval process to submit photos". Follow-up answers (same day):
keep the verified-email requirement; only a **block** stops an account from turning submission back on; activate the
requests still pending; add a per-account cap on photos waiting for review (user: 20); accept for now that a
blocked person can sign up with a new account (blocks stay per principal, ADR-0002 R-d). Amends Backend ADR-0002 decision 2.
Builds on 0.31.0 (Backend `80ad7bf`).

One migration (**0031**), API **0.32.0**.

## Why

Today an account asks for `photographer` (`POST /v1/me/roles/photographer` → `pending`) and an admin approves it before the
account can upload. The user wants any registered website account to be able to submit. Photos still need an admin to
publish them (unchanged), so nothing becomes public without review.

## Decisions

S1. **Keep the `photographer` role as the "may submit" marker; make it self-issued.** The media routes, `holds()`, the
owner-only rules, the demo-account exclusion, the import check and the audit stay as they are. Rejected: dropping
`@Roles("photographer")` from the media routes (every owner/visibility branch, `CallerRoles`, the import and the website
read the role; a block would need a second mechanism); issuing it at `PUT /v1/me` (the game's signup route; the website
needs no player row).

S2. **`POST /v1/me/roles/photographer` activates.** Same route, path, empty body and verified-email check (403 `forbidden`
without one). Demo account → 403 before any read, as today. The unlocked pre-read short-circuits **`active` only** (200
`{ changed: false }`, nothing written) and a pre-read `blocked` → 403 (a stale refusal is safe; saves blocked callers the
global lock). Otherwise, under `lockAccountRoles`: `blocked` → 403; no row, `pending`, `rejected` or `revoked` → `active`
with revision + 1, `requested_at = decided_at = updated_at = at`, `decided_by` = **the principal itself** (same name as the
audit actor, as every other writer), `note = null`, `request_email` = the verified token email. 201 `{ role, changed: true }`.
A `pending` row the old binary writes during the deploy gap is fixed by the account's next POST.

S3. **Audit action `role_self_activate`**, appended to `ADMIN_AUDIT_ACTIONS` and the CHECK; `role_request`, `role_approve`
and `role_reject` stay (historical rows). Actor = target = the principal; detail = the `snapshot()` shape. No email in the
detail.

S4. **Approve and reject go away.** `POST /v1/admin/accounts/{principal}/roles/photographer/approve|reject` are removed (404
like any unknown route); `TRANSITIONS`/`DECIDABLE` lose them; `pending` stays in the state CHECK but nothing new creates it.
Revoke stays: it removes the role and the account may self-activate again (only a block is a ban). Block/unblock
unchanged (unblock → `revoked`, then the account can self-activate). **`GET /v1/admin/role-requests` is unchanged** (default
`?state=pending` kept; it will simply be empty) — no silent contract change, no new index.

S5. **Migration 0031.** Order: `SET LOCAL lock_timeout = '5s'`; `SELECT pg_advisory_xact_lock(hashtextextended('account-roles', 0))`
(orders against a live old-binary role write; role-store.ts:63); the generated DROP/ADD of `admin_audit_action_check`;
then one data-modifying CTE: `UPDATE account_roles SET state='active', revision=revision+1, decided_at=t, decided_by=
'system:self-serve-0031', updated_at=t WHERE role='photographer' AND state='pending' AND request_email IS NOT NULL
RETURNING …` feeding `INSERT INTO admin_audit (actor 'system:self-serve-0031', action 'role_self_activate', target, detail
{role, from:{state:'pending',revision:n-1}, to:{state:'active',revision:n}, note:null}, created_at t)`, with
`t = date_trunc('milliseconds', now())` (one stamp for the whole migration; the app clock's precision). `requested_at` keeps
its original value. Pending rows with a null email (account deleted, or requested before 0017 added the column) stay
pending; harmless, since the account's next POST activates. Demo: requests have refused it since 2026-11-04 and every hosted
row dates from after the 2026-11-16 Firebase project switch, so no demo row can be pending; the guard ignores its roles anyway.

S6. **The "client-chosen role" rule is narrowed in words** (ADR-0002 follow-up 2026-11-26): `photographer` is issued by the
server, to a verified token, at one fixed route with no body; `admin` is never self-issued; a client-chosen role (the
website's sign-in role picker included) still grants nothing. ADR decision 2, decision 6 (audited actions) and Consequences
are updated; a dated note under the 2026-11-16 follow-up says the operator `grantPhotographer` keeps its refusals of
`rejected`/`revoked` (ruling stands) but "decided again" now means the account self-activates (after an unblock if blocked).
Reworded: `grantPhotographer` 403/409 texts (role-store.ts:449-472), `demo-seed.ts:354`, `scripts/roles-grant.mjs:41`, the
`RoleStore` header (role-store.ts:17-21), `MyRolesController` and unblock/grant docs (accounts.controller.ts:112,141-145,221,247),
the `decided_by` comment (schema.ts:851), OpenAPI actor/`decidedBy` descriptions.

S7. **Cap on photos waiting for review.** A non-admin caller may own at most **20** items (user, 2026-11-26;
config `MEDIA_PENDING_CAP_PER_ACCOUNT`, default 20) that are `unverified` and not `declined`. `POST /v1/admin/media` (a new
item) over the cap → **429 `submission_limit`** ("You have 20 photos waiting for review; …"), nothing written, checked inside
the create transaction after locking the owner (a per-principal transaction advisory lock, so two parallel uploads cannot
both pass at N-1). An idempotent replay of an existing key is answered before the cap. New versions of an existing item,
edits and rights are not capped (they don't add items). Admins are exempt. `media:import` is exempt (operator path).

## Not in this wave

- Daily byte caps, email-domain or device checks against block evasion (user: accept for now).
- The website and Admin changes: brief `../docs/briefs/self-serve-photographer.md` (written in slice B).

## Slices

**A — code and tests (implementer 1).** `src/accounts/{role-store,accounts.controller}.ts`, `src/db/{enums,schema}.ts`,
`drizzle/0031_*` + `drizzle/meta`, `src/content/demo-seed.ts` (text only), `scripts/roles-grant.mjs` (text only), and tests:
`role-requests.e2e`, `role-block-email.e2e`, `schema-hardening-accounts.e2e`, `admin-audit.e2e` (DETAILS entry),
`content-publish.test` (action list), `roles.test`, `roles.e2e`, `schema-parity.ts`, `demo-account.e2e`, `demo-seed.e2e`,
new `migration-0031.e2e` (modelled on `migration-0029.e2e`).

**B — media cap (implementer 2).** `src/content/media/media.service.ts`, `src/config/config.module.ts`, `.env.example`,
`src/common/errors.ts` (new code), media tests (new `media-cap.e2e`).

**C — contract and docs (me, after A and B).** `docs/openapi.yaml` (+ `openapi.e2e` enum), `contracts:write` if affected,
API 0.32.0 changelog (breaking: approve/reject removed; new 429), ADR-0002, `CLAUDE.md`, README, ARCHITECTURE, TASKS, the
website brief, a ruling row in `../docs/PROJECT_STATE.md`.

## Tests

- Self-activation from none / pending / rejected / revoked (201, one audit row, revision + 1, `updated_at` moved); active
  no-op (200, no audit); blocked 403 (no write); demo 403; unverified 403.
- Concurrency: `block(rev n)` ∥ self-activate, from pending and from revoked → either activate wins and block is 409, or
  block wins and activate is 403; exactly one audit row for the winner. Two parallel self-activations from revoked → one
  201, one 200, one audit row, revision + 1 once.
- Removed approve/reject routes 404; revoke → self-activate ok; block → 403; unblock → self-activate ok.
- 0031: pending+email → active with the exact audit detail, actor, target, `created_at`, `updated_at`; null-email pending,
  rejected, revoked, blocked, active, admin and player rows unchanged.
- Cap: 20th upload ok, 21st 429 with nothing written; declined/published items don't count; admin exempt; replay at the cap
  still 200; two parallel uploads at 19 → one 201, one 429.
- e2e: a fresh verified account POSTs the role, then uploads (201), with no admin step.

Commands (PowerShell, uppercase drive): `npm run typecheck`, `npm test`, the e2e suite as in README.

## Contract and deploy

- **Breaking for the website:** its Admin approve/reject actions (`website/lib/request/roles.ts:142-148`) get 404 once 0.32.0
  is on dev. Low impact (0031 leaves no pending rows with an email), but the brief tells the website session first.
- 0031 is an irreversible data change. Running it on the hosted dev database (and prod) needs the user's sign-off; nothing
  is deployed in this wave.
