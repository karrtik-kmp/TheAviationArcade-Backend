import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplicationContext } from "@nestjs/common";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoleStore } from "../src/accounts/role-store.js";
import type { RoleActor } from "../src/accounts/role-store.js";
import type { FirebaseAccounts } from "../src/accounts/firebase-accounts.js";
import { BalanceModule } from "../src/balance/balance.module.js";
import { PlayerBalance } from "../src/balance/player-balance.js";
import { ConfigModule } from "../src/config/config.module.js";
import { DatabaseModule, DatabaseService } from "../src/database/database.module.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { clearRoles, demoPrincipal, seedRole } from "./roles-helpers.js";
import { DEMO_HINT_5, seedProduct } from "./store-helpers.js";

// Migration 0027 (docs/plans/schema-hardening.md) against the real test database:
//   C4 account_roles.updated_at moves on every write, and clearEmails bumps revision;
//   C6 ugs_mirror_outbox.first_enqueued_at is "row created at": set once, kept by coalescing;
//   C9 ugs_link_events records every UGS re-link, and the ledgers/purchases are append-only except for account deletion.

const PROJECT = "demo-airplane-games";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let sql: pg.Pool;
let context: INestApplicationContext;
let balance: PlayerBalance;
let store: RoleStore;
const rolePrincipals: string[] = [];
const players: string[] = [];

const operator: RoleActor = { kind: "operator", id: "hardening-test" };
const adminPrincipal = demoPrincipal(`hard-admin-${randomUUID()}`);
const adminActor: RoleActor = { kind: "admin", principal: adminPrincipal };
// Firebase is faked: the admin grant only needs "ok".
const accounts: FirebaseAccounts = {
  ensureEmailVerified: async () => ({ kind: "ok", emailVerification: "no_email" }),
  lookupSessionState: async () => ({ kind: "not_configured" }),
};

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, DatabaseModule, BalanceModule] }).compile();
  context = await moduleRef.init();
  balance = moduleRef.get(PlayerBalance);
  store = new RoleStore(new DatabaseService(sql), { demoPrincipal: demoPrincipal("the-demo-account"), firebaseProjectId: PROJECT }, accounts);
  rolePrincipals.push(adminPrincipal);
  await seedRole(sql, adminPrincipal, "admin");
  // Two active admins, so revoking one is never "the last admin".
  const other = demoPrincipal(`hard-admin2-${randomUUID()}`);
  rolePrincipals.push(other);
  await seedRole(sql, other, "admin");
});

afterAll(async () => {
  await frozenDelete(sql, "admin_audit", "target = ANY($1::text[]) OR actor = ANY($1::text[])", [rolePrincipals]);
  await clearRoles(sql, ...rolePrincipals);
  if (players.length > 0) await sql.query("DELETE FROM players WHERE id = ANY($1::text[])", [players]); // cascade is the one allowed delete
  await sql.end();
  await context.close();
});

const freshRole = (): string => {
  const principal = demoPrincipal(`hard-${randomUUID()}`);
  rolePrincipals.push(principal);
  return principal;
};
const roleRow = async (principal: string, role: string) =>
  (await sql.query("SELECT state, revision, updated_at, request_email, grant_email FROM account_roles WHERE principal = $1 AND role = $2", [principal, role])).rows[0];

/** Run `step`, then require the (principal, role) row's updated_at to have moved forward; returns the new row. */
async function movesUpdatedAt(principal: string, role: string, step: () => Promise<unknown>) {
  const before = await roleRow(principal, role);
  await sleep(15);
  await step();
  const after = await roleRow(principal, role);
  expect(after.updated_at.getTime(), `updated_at after ${role} step`).toBeGreaterThan(before.updated_at.getTime());
  return after;
}

describe("C4: account_roles.updated_at", () => {
  it("issuePlayer sets it on insert", async () => {
    const p = freshRole();
    expect(await store.issuePlayer(p)).toBe(true);
    const row = await roleRow(p, "player");
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it("every photographer transition moves it: self-activate, revoke, self-activate again, block, unblock, self-activate", async () => {
    const p = freshRole();
    const email = "t@example.test";
    const activated = await store.selfActivatePhotographer(p, email);
    expect(activated.ok).toBe(true);
    const first = await roleRow(p, "photographer");
    expect(first.updated_at).toBeInstanceOf(Date);

    let rev = first.revision as number;
    await movesUpdatedAt(p, "photographer", async () => expect((await store.decide(adminActor, p, "photographer", "revoke", rev, null)).ok).toBe(true));
    rev += 1;
    await movesUpdatedAt(p, "photographer", async () => expect((await store.selfActivatePhotographer(p, email)).ok).toBe(true));
    rev += 1;
    await movesUpdatedAt(p, "photographer", async () => expect((await store.setBlocked(adminActor, p, "block", rev, null)).ok).toBe(true));
    rev += 1;
    await movesUpdatedAt(p, "photographer", async () => expect((await store.setBlocked(adminActor, p, "unblock", rev, null)).ok).toBe(true));
    rev += 1;
    await movesUpdatedAt(p, "photographer", async () => expect((await store.selfActivatePhotographer(p, email)).ok).toBe(true));
  });

  it("an operator photographer grant moves it", async () => {
    const p = freshRole();
    await seedRole(sql, p, "photographer", "pending");
    await movesUpdatedAt(p, "photographer", async () => expect((await store.grantPhotographer(operator, p, null)).ok).toBe(true));
  });

  it("every admin transition moves it: grant, email edit, revoke, re-grant", async () => {
    const p = freshRole();
    expect((await store.grantAdmin(adminActor, p, null)).ok).toBe(true);
    const granted = await roleRow(p, "admin");
    expect(granted.updated_at).toBeInstanceOf(Date);
    let rev = granted.revision as number;
    await movesUpdatedAt(p, "admin", async () => expect((await store.editAdminEmail(adminActor, p, rev, "ops@example.test")).ok).toBe(true));
    rev += 1;
    await movesUpdatedAt(p, "admin", async () => expect((await store.decide(adminActor, p, "admin", "revoke", rev, null)).ok).toBe(true));
    await movesUpdatedAt(p, "admin", async () => expect((await store.grantAdmin(adminActor, p, null)).ok).toBe(true));
  });

  it("an unchanged admin email edit changes nothing, including updated_at", async () => {
    const p = freshRole();
    await store.grantAdmin(adminActor, p, null, { email: undefined });
    const before = await roleRow(p, "admin");
    await sleep(15);
    expect((await store.editAdminEmail(adminActor, p, before.revision, before.grant_email)).ok).toBe(true);
    const after = await roleRow(p, "admin");
    expect(after.updated_at).toEqual(before.updated_at);
    expect(after.revision).toBe(before.revision);
  });

  it("clearEmails clears both emails, bumps revision and sets updated_at on each row that held one; a second call writes nothing", async () => {
    const p = freshRole();
    await store.selfActivatePhotographer(p, "req@example.test");
    await store.issuePlayer(p);
    expect((await store.grantAdmin(adminActor, p, null)).ok).toBe(true);
    const admin = await roleRow(p, "admin");
    await store.editAdminEmail(adminActor, p, admin.revision, "typed@example.test");
    const photographerBefore = await roleRow(p, "photographer");
    const adminBefore = await roleRow(p, "admin");
    const playerBefore = await roleRow(p, "player");
    expect(photographerBefore.request_email).toBe("req@example.test");
    expect(adminBefore.grant_email).toBe("typed@example.test");

    await sleep(15);
    await store.clearEmails(p);
    const photographer = await roleRow(p, "photographer");
    const adminAfter = await roleRow(p, "admin");
    expect(photographer).toMatchObject({ request_email: null, revision: photographerBefore.revision + 1 });
    expect(adminAfter).toMatchObject({ grant_email: null, revision: adminBefore.revision + 1 });
    expect(photographer.updated_at.getTime()).toBeGreaterThan(photographerBefore.updated_at.getTime());
    expect(adminAfter.updated_at.getTime()).toBeGreaterThan(adminBefore.updated_at.getTime());
    // The player row held no email, so it is untouched.
    expect(await roleRow(p, "player")).toEqual(playerBefore);

    await store.clearEmails(p);
    expect(await roleRow(p, "photographer")).toEqual(photographer);
    expect(await roleRow(p, "admin")).toEqual(adminAfter);
  });

  it("a revision-fenced editor holding the pre-clear row is refused", async () => {
    const p = freshRole();
    expect((await store.grantAdmin(adminActor, p, null)).ok).toBe(true);
    const admin = await roleRow(p, "admin");
    await store.editAdminEmail(adminActor, p, admin.revision, "typed@example.test");
    const stale = (await roleRow(p, "admin")).revision as number;
    await store.clearEmails(p);
    const refused = await store.editAdminEmail(adminActor, p, stale, "other@example.test");
    expect(refused.ok).toBe(false);
  });
});

async function newPlayer(opts: { linked?: string } = {}): Promise<string> {
  const id = `${demoPrincipal("hard-p-")}${randomUUID()}`;
  players.push(id);
  await sql.query("INSERT INTO players (id, miles, hints, created_at, updated_at) VALUES ($1, 0, 0, now(), now())", [id]);
  if (opts.linked) await sql.query("INSERT INTO ugs_links (player_id, ugs_player_id, linked_at) VALUES ($1, $2, now())", [id, opts.linked]);
  return id;
}
const ugsId = () => `ugs-${randomUUID()}`;
const outbox = async (id: string) => (await sql.query("SELECT * FROM ugs_mirror_outbox WHERE player_id = $1", [id])).rows[0];
const events = async (id: string) =>
  (await sql.query("SELECT kind, ugs_player_id, previous_ugs_player_id, created_at FROM ugs_link_events WHERE player_id = $1 ORDER BY id", [id])).rows;

describe("C6: ugs_mirror_outbox.first_enqueued_at", () => {
  it("is set on the first enqueue and unchanged when a later write coalesces into the same row", async () => {
    const id = await newPlayer({ linked: ugsId() });
    expect(await outbox(id)).toBeUndefined();
    await balance.update(id, async () => ({ value: null, profile: { activeRank: "trainee" as const } }));
    const first = await outbox(id);
    expect(first.first_enqueued_at).toBeInstanceOf(Date);

    await sleep(25);
    await balance.update(id, async () => ({ value: null, change: { statusPoints: 1 }, republish: true as const }));
    const second = await outbox(id);
    // Same row (coalesced): the generation moved and the version kept its maximum, but first_enqueued_at is still the first write's.
    expect(Number(second.generation)).toBeGreaterThan(Number(first.generation));
    expect(second.version).toBeGreaterThan(first.version);
    expect(second.first_enqueued_at).toEqual(first.first_enqueued_at);
    expect((await sql.query("SELECT 1 FROM ugs_mirror_outbox WHERE player_id = $1", [id])).rowCount).toBe(1);
  });

  it("a row deleted and enqueued again gets a new first_enqueued_at", async () => {
    const id = await newPlayer({ linked: ugsId() });
    await balance.update(id, async () => ({ value: null, republish: true as const }));
    const first = await outbox(id);
    await sleep(25);
    await sql.query("DELETE FROM ugs_mirror_outbox WHERE player_id = $1", [id]);
    await balance.update(id, async () => ({ value: null, republish: true as const }));
    expect((await outbox(id)).first_enqueued_at.getTime()).toBeGreaterThan(first.first_enqueued_at.getTime());
  });
});

describe("C9: ugs_link_events", () => {
  it("a first link writes 'linked'", async () => {
    const p = await newPlayer();
    const u = ugsId();
    expect(await balance.linkUgs(p, u)).toMatchObject({ kind: "linked", created: true });
    expect(await events(p)).toEqual([expect.objectContaining({ kind: "linked", ugs_player_id: u, previous_ugs_player_id: null })]);
  });

  it("a relink to a different UGS id writes 'replaced' with the previous id", async () => {
    const p = await newPlayer();
    const first = ugsId();
    const second = ugsId();
    await balance.linkUgs(p, first);
    await balance.linkUgs(p, second);
    expect((await events(p)).map((e) => [e.kind, e.ugs_player_id, e.previous_ugs_player_id])).toEqual([
      ["linked", first, null],
      ["replaced", second, first],
    ]);
  });

  it("moving a UGS id from another player writes 'moved_away' for the old holder and 'linked' for the caller", async () => {
    const holder = await newPlayer();
    const caller = await newPlayer();
    const u = ugsId();
    await balance.linkUgs(holder, u);
    expect((await balance.linkUgs(caller, u)).kind).toBe("held"); // without moveFrom nothing is written
    expect(await events(caller)).toEqual([]);
    expect((await events(holder)).map((e) => e.kind)).toEqual(["linked"]);

    expect(await balance.linkUgs(caller, u, holder)).toMatchObject({ kind: "linked", created: true });
    expect((await events(holder)).map((e) => [e.kind, e.ugs_player_id])).toEqual([["linked", u], ["moved_away", u]]);
    expect((await events(caller)).map((e) => [e.kind, e.ugs_player_id])).toEqual([["linked", u]]);
  });

  it("a relink to the same UGS id writes nothing", async () => {
    const p = await newPlayer();
    const u = ugsId();
    await balance.linkUgs(p, u);
    expect(await balance.linkUgs(p, u)).toMatchObject({ kind: "linked", created: false });
    expect(await events(p)).toHaveLength(1);
  });

  it("deleting the player cascades its events, and a direct DELETE or UPDATE on them is refused", async () => {
    const p = await newPlayer();
    await balance.linkUgs(p, ugsId());
    await balance.linkUgs(p, ugsId());
    expect(await events(p)).toHaveLength(2);
    await expect(sql.query("DELETE FROM ugs_link_events WHERE player_id = $1", [p])).rejects.toMatchObject({ code: "23001" });
    await expect(sql.query("UPDATE ugs_link_events SET kind = 'linked' WHERE player_id = $1", [p])).rejects.toMatchObject({ code: "23001" });
    expect(await events(p)).toHaveLength(2);
    expect(await balance.erase(p)).toBe(true); // erase writes no event of its own and the cascade passes the trigger
    expect(await events(p)).toEqual([]);
  });
});

describe("append-only ledgers and purchases survive everything but account deletion", () => {
  it("miles, hint and store rows refuse a direct DELETE and UPDATE; deleting the account removes them", async () => {
    await seedProduct(sql, { productId: DEMO_HINT_5, kind: "hint_pack", hints: 5, demo: true });
    const p = await newPlayer();
    await sql.query("INSERT INTO miles_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, 1, 'round_award', $2, now())", [p, `seed-${p}`]);
    await sql.query("INSERT INTO hint_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, 1, 'starter', 'starter', now())", [p]);
    await sql.query(
      `INSERT INTO store_transactions (store, transaction_ref, player_id, product_id, kind, environment, purchased_at, granted_hints)
       VALUES ('apple', $1, $2, $3, 'hint_pack', 'sandbox', now(), 5)`,
      [`tx-${p}`, p, DEMO_HINT_5],
    );
    for (const table of ["miles_ledger", "hint_ledger", "store_transactions"]) {
      await expect(sql.query(`DELETE FROM ${table} WHERE player_id = $1`, [p]), `${table} delete`).rejects.toMatchObject({ code: "23001" });
      expect((await sql.query(`SELECT 1 FROM ${table} WHERE player_id = $1`, [p])).rowCount, `${table} survives`).toBe(1);
    }
    await expect(sql.query("UPDATE miles_ledger SET delta = 1 WHERE player_id = $1", [p])).rejects.toMatchObject({ code: "23001" });
    await expect(sql.query("UPDATE store_transactions SET granted_hints = 9 WHERE player_id = $1", [p])).rejects.toMatchObject({ code: "23001" });

    expect(await balance.erase(p)).toBe(true);
    for (const table of ["miles_ledger", "hint_ledger", "store_transactions"]) {
      expect((await sql.query(`SELECT 1 FROM ${table} WHERE player_id = $1`, [p])).rowCount, `${table} cascaded`).toBe(0);
    }
  });
});
