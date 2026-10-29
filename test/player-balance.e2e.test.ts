import { randomUUID } from "node:crypto";
import { sql as dsql } from "drizzle-orm";
import { Test } from "@nestjs/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BalanceModule } from "../src/balance/balance.module.js";
import { PlayerBalance } from "../src/balance/player-balance.js";
import { ConfigModule } from "../src/config/config.module.js";
import { DatabaseModule, PG_POOL } from "../src/database/database.module.js";
import type { INestApplicationContext } from "@nestjs/common";

// PlayerBalance at its own interface, against the real test database: no HTTP, no Rounds, no shop.

let context: INestApplicationContext;
let balance: PlayerBalance;
let sql: pg.Pool;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, DatabaseModule, BalanceModule] }).compile();
  context = await moduleRef.init();
  balance = moduleRef.get(PlayerBalance);
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});

afterAll(async () => {
  await sql.end();
  await context.close();
});

const NOW = new Date("2026-10-29T12:00:00.000Z");

async function newPlayer(opts: { miles?: number; hints?: number; linked?: boolean } = {}): Promise<string> {
  const id = `firebase:demo-airplane-games:bal-${randomUUID()}`;
  await sql.query("INSERT INTO players (id, miles, hints, created_at, updated_at) VALUES ($1, $2, $3, now(), now())", [
    id,
    opts.miles ?? 0,
    opts.hints ?? 0,
  ]);
  // Keep the ledgers consistent with the seeded balances (invariant 7).
  if (opts.miles) {
    await sql.query("INSERT INTO miles_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, $2, 'round_award', $3, now())", [id, opts.miles, `seed-${id}`]);
  }
  if (opts.hints) {
    await sql.query("INSERT INTO hint_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, $2, 'starter', 'starter', now())", [id, opts.hints]);
  }
  if (opts.linked) {
    await sql.query("INSERT INTO ugs_links (player_id, ugs_player_id, linked_at) VALUES ($1, $2, now())", [id, `ugs-${id}`]);
  }
  return id;
}

async function row(id: string) {
  return (await sql.query("SELECT * FROM players WHERE id = $1", [id])).rows[0];
}
async function outbox(id: string) {
  return (await sql.query("SELECT * FROM ugs_mirror_outbox WHERE player_id = $1", [id])).rows;
}
async function ledgerSums(id: string) {
  const miles = (await sql.query("SELECT COALESCE(SUM(delta), 0)::int AS s FROM miles_ledger WHERE player_id = $1", [id])).rows[0].s;
  const hints = (await sql.query("SELECT COALESCE(SUM(delta), 0)::int AS s FROM hint_ledger WHERE player_id = $1", [id])).rows[0].s;
  return { miles, hints };
}

describe("PlayerBalance.update", () => {
  it("answers no_player for a missing row and never runs the callback", async () => {
    let ran = false;
    const result = await balance.update(`firebase:demo-airplane-games:none-${randomUUID()}`, NOW, async () => {
      ran = true;
      return { value: 1 };
    });
    expect(result).toEqual({ kind: "no_player" });
    expect(ran).toBe(false);
  });

  it("an Active Rank change bumps the version and enqueues; the same value again changes nothing", async () => {
    const id = await newPlayer({ linked: true });
    const first = await balance.update(id, NOW, async () => ({ value: null, profile: { activeRank: "trainee" as const } }));
    expect(first.kind === "ok" && first.player.activeRank).toBe("trainee");
    expect((await row(id)).version).toBe(2);
    const queued = await outbox(id);
    expect(queued).toHaveLength(1);
    expect(queued[0].version).toBe(2);

    await sql.query("DELETE FROM ugs_mirror_outbox WHERE player_id = $1", [id]);
    const again = await balance.update(id, NOW, async () => ({ value: null, profile: { activeRank: "trainee" as const } }));
    expect(again.kind === "ok" && again.player.version).toBe(2);
    expect((await row(id)).version).toBe(2);
    expect(await outbox(id)).toEqual([]);
  });

  it("postings write ledger rows, bump the version once and enqueue once", async () => {
    const id = await newPlayer({ miles: 100, hints: 3, linked: true });
    const result = await balance.update(id, NOW, async () => ({
      value: "done",
      change: {
        statusPoints: 7,
        perfectStreak: 4,
        postings: [
          { account: "miles" as const, delta: 50, kind: "round_award" as const, ref: "r1" },
          { account: "hints" as const, delta: -1, kind: "round_spend" as const, ref: "r1" },
        ],
      },
    }));
    expect(result.kind).toBe("ok");
    const player = await row(id);
    expect(player).toMatchObject({ status_points: 7, miles: 150, hints: 2, perfect_streak: 4, version: 2 });
    expect(await ledgerSums(id)).toEqual({ miles: 150, hints: 2 });
    const queued = await outbox(id);
    expect(queued).toHaveLength(1);
    expect(queued[0].version).toBe(2);
  });

  it("an all-zero change is still a progress event (an unfinished Round bumps the version and enqueues)", async () => {
    const id = await newPlayer({ linked: true });
    const result = await balance.update(id, NOW, async () => ({
      value: null,
      change: { statusPoints: 0, perfectStreak: 0, postings: [{ account: "miles" as const, delta: 0, kind: "round_award" as const, ref: "r0" }] },
    }));
    expect(result.kind).toBe("ok");
    expect((await row(id)).version).toBe(2);
    expect(await outbox(id)).toHaveLength(1);
  });

  it("a zero posting writes no ledger row", async () => {
    const id = await newPlayer();
    await balance.update(id, NOW, async () => ({
      value: null,
      change: { postings: [{ account: "miles" as const, delta: 0, kind: "round_award" as const, ref: "zero" }] },
    }));
    expect((await sql.query("SELECT 1 FROM miles_ledger WHERE player_id = $1 AND ref = 'zero'", [id])).rowCount).toBe(0);
  });

  it("a step with no change leaves everything alone", async () => {
    const id = await newPlayer({ linked: true });
    const result = await balance.update(id, NOW, async () => ({ value: "lock only" }));
    expect(result.kind === "ok" && result.value).toBe("lock only");
    expect((await row(id)).version).toBe(1);
    expect(await outbox(id)).toEqual([]);
  });

  it("an insufficient debit rolls back a row the caller wrote through p.tx", async () => {
    const id = await newPlayer({ miles: 10 });
    const result = await balance.update(id, NOW, async ({ tx }) => {
      await tx.execute(dsql`UPDATE players SET perfect_streak = 9 WHERE id = ${id}`);
      return { value: null, change: { postings: [{ account: "miles" as const, delta: -11, kind: "hint_pack" as const, ref: "k" }] } };
    });
    expect(result).toEqual({ kind: "insufficient", account: "miles" });
    expect(await row(id)).toMatchObject({ miles: 10, perfect_streak: 0, version: 1 });
    expect((await sql.query("SELECT 1 FROM miles_ledger WHERE player_id = $1 AND ref = 'k'", [id])).rowCount).toBe(0);
  });

  it("an insufficient debit keeps the pooled connection (a refusal is not a broken connection)", async () => {
    const pool = context.get<pg.Pool>(PG_POOL);
    const id = await newPlayer({ miles: 1 });
    // Warm one client so the count below is stable.
    await balance.update(id, NOW, async () => ({ value: null }));
    const before = pool.totalCount;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await balance.update(id, NOW, async () => ({
        value: null,
        change: { postings: [{ account: "miles" as const, delta: -5, kind: "hint_pack" as const, ref: `k${attempt}` }] },
      }));
      expect(result).toEqual({ kind: "insufficient", account: "miles" });
    }
    expect(pool.totalCount).toBe(before);
    expect(pool.idleCount).toBe(before);
  });

  it("a profile change and a balance change in one step bump the version once", async () => {
    const id = await newPlayer({ linked: true });
    const result = await balance.update(id, NOW, async () => ({
      value: null,
      profile: { activeRank: "trainee" as const },
      change: { statusPoints: 5 },
    }));
    expect(result.kind).toBe("ok");
    expect(await row(id)).toMatchObject({ version: 2, active_rank: "trainee", status_points: 5 });
    const queued = await outbox(id);
    expect(queued).toHaveLength(1);
    expect(queued[0].version).toBe(2);
  });

  it("an insufficient hints debit is reported as hints", async () => {
    const id = await newPlayer({ hints: 0 });
    const result = await balance.update(id, NOW, async () => ({
      value: null,
      change: { postings: [{ account: "hints" as const, delta: -1, kind: "round_spend" as const, ref: "h" }] },
    }));
    expect(result).toEqual({ kind: "insufficient", account: "hints" });
  });

  it("posted() finds a prior entry and null otherwise", async () => {
    const id = await newPlayer();
    await balance.update(id, NOW, async () => ({
      value: null,
      change: { postings: [{ account: "hints" as const, delta: 10, kind: "hint_pack" as const, ref: "key-1" }] },
    }));
    const seen = await balance.update(id, NOW, async (p) => ({
      value: {
        hit: await p.posted("hints", "hint_pack", "key-1"),
        miss: await p.posted("hints", "hint_pack", "key-2"),
        wrongAccount: await p.posted("miles", "hint_pack", "key-1"),
      },
    }));
    expect(seen.kind === "ok" && seen.value).toEqual({ hit: 10, miss: null, wrongAccount: null });
  });

  it("republish enqueues at the unchanged version", async () => {
    const id = await newPlayer({ linked: true });
    await balance.update(id, NOW, async () => ({ value: null, republish: true as const }));
    expect((await row(id)).version).toBe(1);
    const queued = await outbox(id);
    expect(queued).toHaveLength(1);
    expect(queued[0].version).toBe(1);
  });

  it("two concurrent update() calls serialise and keep SUM(ledger) equal to the balance", async () => {
    const id = await newPlayer({ miles: 100 });
    const debit = (ref: string) =>
      balance.update(id, NOW, async () => ({
        value: ref,
        change: { postings: [{ account: "miles" as const, delta: -60, kind: "hint_pack" as const, ref }] },
      }));
    const results = await Promise.all([debit("a"), debit("b")]);
    expect(results.map((r) => r.kind).sort()).toEqual(["insufficient", "ok"]);
    expect(await row(id)).toMatchObject({ miles: 40, version: 2 });
    expect(await ledgerSums(id)).toEqual({ miles: 40, hints: 0 });
  });

  it("nothing is enqueued for an unlinked player", async () => {
    const id = await newPlayer();
    await balance.update(id, NOW, async () => ({ value: null, change: { statusPoints: 1 }, republish: true as const }));
    expect(await outbox(id)).toEqual([]);
    expect((await row(id)).version).toBe(2);
  });
});
