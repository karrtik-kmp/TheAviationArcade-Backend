# Backend ADR-0002: Role-based access from the backend database

**Status:** Accepted (user, 2026-11-03)
**Date:** 2026-11-03
**Deciders:** the user; the backend session implements.
**Supersedes:** the 2026-10-28 ruling "staff = token `email_verified === true` AND lowercased `email` in server-only
`STAFF_EMAILS`" (`docs/TASKS.md` Decisions).

## Context

The media pipeline ([ADR-0001](ADR-0001-image-storage-and-delivery.md),
[plans/media-pipeline.md](../plans/media-pipeline.md)) needs two kinds of privileged user:
- **photographers**, who upload images;
- **admins**, who publish them.

Today the backend knows only "staff": a verified email listed in the `STAFF_EMAILS` environment variable. That has three
problems: every change needs a config edit and a restart; it can't tell photographers from admins; and it keys
privileges on an email string rather than on the account.

Fixed constraints:
- **Identity stays Firebase.** The game signs in through Unity Authentication's `oidc-firebase` provider (proven
  2026-11-02, `externalId` = Firebase uid). The backend verifies the Firebase ID token, and the account principal stays
  `firebase:<projectId>:<uid>`.
- **A role the client chooses never grants privileges.** This is a standing project rule.
- Firebase allows one account per email per project.

## Decision

1. **Roles live in the backend database**, in an `account_roles` table keyed by principal. The table is separate from
   `players`, so deleting game data never removes a role, and staff need no player row. One person has one Firebase
   sign-in and a **set** of roles.
2. **Roles and how each is issued:**
   - `player`: issued at signup (`PUT /v1/me`).
   - `photographer`: the account **requests** it through its own registration route and gets a `pending` row, which an
     admin approves or rejects.
   - `admin`: never self-registered. It is granted by another admin, or, for the very first admin, by a one-time
     operator command (`npm run roles:grant -- <uid> admin`). The command is audited like every grant.
3. **Admin includes every photographer permission.**
4. **Endpoint security is role-based only.** A guard reads the caller's active roles from the database on every protected
   request (one indexed lookup), so a revoke takes effect on the next call. Photographer and admin also require
   `email_verified === true` in the token.
5. **`STAFF_EMAILS` is retired.** The routes that used `@StaffOnly` now require the `admin` role. No environment list
   grants anything.
6. **Every role change is audited**, with who, what, when and the before and after state: request, approve, reject,
   grant and revoke.
7. **Photographers only see and change their own uploads.** Publishing, withdrawing, attaching images to content items
   and deciding roles are admin-only.

## Follow-up rulings (user, 2026-11-03, after the plan gate)

- At least one active admin always remains; self-revoke is allowed while another admin exists. Enforced under one
  transaction-scoped advisory lock taken by every role change, which also re-checks the acting admin.
- Decisions are fenced by a per-row `revision`; only the legal transitions in `docs/plans/media-pipeline.md` R-b exist.
- `player` is issued on every `PUT /v1/me` (no backfill), is informational, and is not revocable in this wave.
- A photographer request needs a verified email and records it for admins only; `DELETE /v1/me` clears that email but
  keeps role rows and audit rows (decision 1).
- `roles:grant` accepts only `admin` and runs only when no active admin exists (first admin or recovery), with `--yes`.

## Options considered

| Option | Verdict |
|---|---|
| A. `account_roles` table, admin-granted, read per request (chosen) | No restarts; revocable at once; audited; account-keyed |
| B. Keep env allowlists (`STAFF_EMAILS`, add `PHOTOGRAPHER_EMAILS`) | Config edit and restart per person; keyed on email strings |
| C. `role` column on `players` | Deleting game data deletes the role; staff would need a player row; one role per person |
| D. Trust the website's role flag | Forbidden: another service's or the client's word never grants a role |
| E. Separate sign-in per role (a different email each) | Possible, but two logins per person; rejected in favour of one identity with several roles |

## Consequences

- **Easier:**
  - Onboarding a photographer is an approval click, not a deploy.
  - Revocation is immediate.
  - The audit trail is complete.
- **Harder:**
  - One extra database read on each protected request. It is indexed and small; cache it only if profiling shows a need.
  - The very first admin needs operator access to run the command.
  - Existing tests and the website, which relied on `STAFF_EMAILS`, must move to roles.
- **Cross-repo:**
  - The website's CLAUDE.md and AGENTS.md still state the `STAFF_EMAILS` rule for its own admin screens. The website
    session must be told.
  - Its server-to-server calls keep using the staff member's own token; the backend now checks that account's roles.
  - Unity is unaffected: players get `player` automatically.

## Action items

1. [ ] Migration: `account_roles` (principal, role, state `pending|active|rejected|revoked`, requested_at, decided_at,
   decided_by, note), unique (principal, role), CHECK lists with S5 parity, audit actions for every role change.
2. [ ] `RolesGuard` with `@Roles(...)` (verified email for photographer and admin); swap `@StaffOnly` for
   `@Roles("admin")`; remove `STAFF_EMAILS` (config, docs, tests); `GET /v1/admin/me` returns roles.
3. [ ] Routes:
   - `PUT /v1/me` issues `player`;
   - `POST /v1/me/roles/photographer` requests the role;
   - admin `GET /v1/admin/role-requests`;
   - admin `POST /v1/admin/accounts/{principal}/roles/{role}/approve|reject|revoke`;
   - admin grant of `admin`.
4. [ ] `npm run roles:grant` operator command (direct database, audited, refuses a principal from another Firebase
   project).
5. [ ] Update this repo's `CLAUDE.md`, README and ARCHITECTURE; message the website session.
