# Airplane Games backend — agent rules

Standalone Node game backend: NestJS + PostgreSQL (Drizzle) + Firebase ID tokens (jose). Deployed
separately from the website. Read `README.md`, `docs/TASKS.md` and `docs/ARCHITECTURE.md` (what we build
and deliberately don't) first.
Sibling repos: website `../website` (same Firebase project, same principal format), Unity game
`C:\Unity\Projects\AviationArcade_v2` (economy rules originate there; v1 is superseded). Design docs: `../docs/`.

## Commands

See README. Local Postgres: `docker compose up -d`. No cloud or hosting commands without explicit user
sign-off.

## Rules that must not be broken

- Principal = `firebase:<projectId>:<uid>` from a verified token only. Providers: email/password and
  Google; the game signs in through Unity Auth's `oidc-firebase` provider, so the backend still verifies Firebase tokens.
  Never trust a client-supplied ID, role, name or email.
- Privileges come only from the backend `account_roles` table (docs/adr/ADR-0002): `player` at signup, `photographer`
  by request + admin approval, `admin` only by grant (or the audited `roles:grant` command). Guards read roles per
  request; photographer/admin also need a verified email. No env allowlist grants anything (`STAFF_EMAILS` retired).
- Cloud project `airplane-games-auth-20261022`; local/tests use only `demo-airplane-games`. Unsigned
  emulator tokens are accepted for exactly that demo project. Never commit `.env*` (except
  `.env.example`), keys or Bunny passwords.
- File/blob storage is Bunny Storage (S3 API), as on the website; private by default. See
  ARCHITECTURE.md "File storage".
- The server computes every award. Clients report Round facts only; request schemas stay strict.
- Every balance-changing write runs in one transaction (via `PlayerBalance.update`) that locks the player row
  first and bumps `players.version`. Never overwrite another write; never retry under a different identity.
- `src/rules/` mirrors Unity `ScoreCalculator`/`FlightRank`/`PilotProgression`. Change both together;
  keep test names aligned. Spec ambiguities become `ASSUMPTION:` tests, never silent picks.
- Use Unity `CONTEXT.md` vocabulary: Miles (not coins), Status Points, Round, Module, Certified/Active
  Rank, Pleasure Cruise, Flight Segment. Unity ADR-0007 renamed two terms: a backend **Round** is one
  **Flight** and a **Flight Segment** is a **Trip**. Keep the backend type names; use the mapping in contracts
  and messages to other repos.
- Applied migrations are immutable: generate a new one.
- `contracts/` is generated (`npm run contracts:write`), never hand-edited; consumers vendor it verbatim. See
  `contracts/README.md`.

## Workflow

- Pin exact versions; prefer stable releases at least two weeks old; no prereleases. Verify library
  behaviour against current official docs, not memory.
- Delegate scoped implementation to subagents with explicit file ownership; get an independent review
  for non-trivial changes; integrate and verify yourself.
- Named agents: user-level `senior-lead`, `backend-expert`, `frontend-expert`, `devops-expert`, `researcher`,
  `implementer`, `code-reviewer` (`~/.claude/agents/`); repo-level `game-domain-expert`, `rules-sync`
  (`.claude/agents/`). Per wave: plan → `senior-lead` + the relevant experts in parallel → `implementer`s →
  `code-reviewer` → commit. Tiny mechanical changes skip the plan gate.
- Focused commits, inspect staged files, record actual verification in `docs/TASKS.md`.
- Work on `main` (no worktrees or side branches); push to `origin` after each verified piece.
