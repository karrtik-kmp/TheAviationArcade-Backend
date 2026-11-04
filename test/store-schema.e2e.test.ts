import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_PRODUCTS } from "../src/store/demo-products.js";
import { DEMO_HINT_5, DEMO_PASS_MONTHLY, seedDemoProducts, seedProduct } from "./store-helpers.js";

// Migration 0020 (docs/plans/purchases.md, slice P-A): the store tables' CHECKs, keys and cascades against the real test database,
// written as raw SQL so a drifted constraint fails here whatever the services do. Every row uses unique ids or references.

const PLAYER = `firebase:demo-airplane-games:store-schema-${randomUUID()}`;
const OTHER = `firebase:demo-airplane-games:store-schema-${randomUUID()}`;
const REF = `ref-${randomUUID()}`;
const EXTRA = `aa.schema.${randomUUID().slice(0, 8)}`;

let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await seedDemoProducts(pool);
  for (const id of [PLAYER, OTHER]) {
    await pool.query("INSERT INTO players (id, created_at, updated_at) VALUES ($1, now(), now())", [id]);
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM players WHERE id = ANY($1)", [[PLAYER, OTHER]]);
  await pool.query("DELETE FROM admin_audit WHERE target = $1", [EXTRA]);
  await pool.query("DELETE FROM store_products WHERE product_id = $1", [EXTRA]);
  await pool.end();
});

/** The name of the constraint a statement violates, or null when it succeeds (any other error is rethrown). */
async function violated(text: string, values: unknown[] = []): Promise<string | null> {
  try {
    await pool.query(text, values);
    return null;
  } catch (error) {
    const e = error as { constraint?: string };
    if (!e.constraint) throw error;
    return e.constraint;
  }
}

const product = (
  id: string,
  kind: string,
  hints: number | null,
  period: string | null,
  extra: { title?: string; status?: string; version?: number } = {},
) =>
  violated(
    `INSERT INTO store_products (product_id, kind, hints, pass_period, title, demo, status, version)
     VALUES ($1, $2, $3, $4, $5, false, $6, $7)`,
    [id, kind, hints, period, extra.title ?? "t", extra.status ?? "active", extra.version ?? 1],
  );

type TxnOverrides = {
  kind?: string;
  hints?: number | null;
  until?: string | null;
  original?: string | null;
  store?: string;
  env?: string;
  product?: string;
  player?: string;
  ref?: string;
};

let counter = 0;
const txn = (over: TxnOverrides = {}) => {
  const kind = over.kind ?? "hint_pack";
  const isPass = kind === "first_class_pass";
  return violated(
    `INSERT INTO store_transactions (store, transaction_ref, player_id, product_id, kind, environment, purchased_at, granted_hints, granted_until, original_ref)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9)`,
    [
      over.store ?? "apple",
      over.ref ?? `${REF}-${++counter}`,
      over.player ?? PLAYER,
      over.product ?? (isPass ? DEMO_PASS_MONTHLY : DEMO_HINT_5),
      kind,
      over.env ?? "fake",
      "hints" in over ? over.hints : isPass ? null : 5,
      "until" in over ? over.until : isPass ? "2030-01-01T00:00:00Z" : null,
      "original" in over ? over.original : isPass ? "orig-1" : null,
    ],
  );
};

describe("migration 0020: store_products", () => {
  it("the seed list satisfies every CHECK (four rows, all demo)", async () => {
    expect(DEMO_PRODUCTS).toHaveLength(4);
    const { rows } = await pool.query("SELECT product_id FROM store_products WHERE demo AND product_id = ANY($1)", [
      DEMO_PRODUCTS.map((p) => p.productId),
    ]);
    expect(rows).toHaveLength(4);
  });

  it("enforces the product id pattern", async () => {
    for (const bad of ["", "A.b", ".a", "a b", "a-b", "x".repeat(101)]) {
      expect(await product(bad, "hint_pack", 5, null), JSON.stringify(bad)).toBe("store_products_product_id_check");
    }
  });

  it("enforces the kind, period and status lists", async () => {
    expect(await product(EXTRA, "miles_pack", 5, null)).toBe("store_products_kind_check");
    expect(await product(EXTRA, "first_class_pass", null, "P1W")).toBe("store_products_pass_period_check");
    expect(await product(EXTRA, "hint_pack", 5, null, { status: "gone" })).toBe("store_products_status_check");
  });

  it("enforces the per-kind rule: a hint pack has 1..1000 hints and no period, a Pass a period and no hints", async () => {
    expect(await product(EXTRA, "hint_pack", null, null)).toBe("store_products_kind_rule_check");
    expect(await product(EXTRA, "hint_pack", 0, null)).toBe("store_products_kind_rule_check");
    expect(await product(EXTRA, "hint_pack", 1001, null)).toBe("store_products_kind_rule_check");
    expect(await product(EXTRA, "hint_pack", 5, "P1M")).toBe("store_products_kind_rule_check");
    expect(await product(EXTRA, "first_class_pass", 5, "P1M")).toBe("store_products_kind_rule_check");
    expect(await product(EXTRA, "first_class_pass", null, null)).toBe("store_products_kind_rule_check");
    expect(await product(EXTRA, "hint_pack", 1000, null)).toBeNull();
    await pool.query("DELETE FROM store_products WHERE product_id = $1", [EXTRA]);
    expect(await product(EXTRA, "first_class_pass", null, "P1Y")).toBeNull();
  });

  it("enforces title length and version", async () => {
    await pool.query("DELETE FROM store_products WHERE product_id = $1", [EXTRA]);
    expect(await product(EXTRA, "hint_pack", 5, null, { title: "" })).toBe("store_products_title_check");
    expect(await product(EXTRA, "hint_pack", 5, null, { title: "x".repeat(101) })).toBe("store_products_title_check");
    expect(await product(EXTRA, "hint_pack", 5, null, { version: 0 })).toBe("store_products_version_check");
  });
});

describe("migration 0020: store_transactions", () => {
  it("accepts a valid hint pack and a valid Pass row", async () => {
    expect(await txn()).toBeNull();
    expect(await txn({ kind: "first_class_pass" })).toBeNull();
  });

  it("enforces the store, kind and environment lists", async () => {
    expect(await txn({ store: "amazon" })).toBe("store_transactions_store_check");
    expect(await txn({ kind: "miles_pack" })).toBe("store_transactions_kind_check");
    expect(await txn({ env: "staging" })).toBe("store_transactions_environment_check");
  });

  it("enforces the per-kind rule: a pack grants hints and has no original_ref, a Pass has an expiry and an original_ref", async () => {
    expect(await txn({ hints: null })).toBe("store_transactions_kind_rule_check");
    expect(await txn({ original: "orig-1" })).toBe("store_transactions_kind_rule_check");
    expect(await txn({ until: "2030-01-01T00:00:00Z" })).toBe("store_transactions_kind_rule_check"); // a pack has no expiry
    expect(await txn({ kind: "first_class_pass", hints: 5 })).toBe("store_transactions_kind_rule_check"); // a Pass grants no hints
    expect(await txn({ kind: "first_class_pass", until: null })).toBe("store_transactions_kind_rule_check");
    expect(await txn({ kind: "first_class_pass", original: null })).toBe("store_transactions_kind_rule_check");
    expect(await txn({ hints: 0 })).toBe("store_transactions_granted_hints_check");
  });

  it("one reference is granted once per store, across players; the same reference in the other store is another transaction", async () => {
    const ref = `${REF}-unique`;
    expect(await txn({ ref })).toBeNull();
    expect(await txn({ ref })).toBe("store_transactions_store_ref");
    expect(await txn({ ref, player: OTHER })).toBe("store_transactions_store_ref");
    expect(await txn({ ref, store: "google" })).toBeNull();
  });

  it("refuses an unknown product and RESTRICTs deleting a product with a transaction", async () => {
    expect(await txn({ product: "aa.no.such.product" })).toBe("store_transactions_product_id_store_products_product_id_fk");
    expect(await violated("DELETE FROM store_products WHERE product_id = $1", [DEMO_HINT_5])).toBe(
      "store_transactions_product_id_store_products_product_id_fk",
    );
  });
});

describe("migration 0020: store_subscriptions and store_accounts", () => {
  const sub = (over: { store?: string; original?: string; status?: string; player?: string } = {}) =>
    violated(
      `INSERT INTO store_subscriptions (store, original_ref, player_id, product_id, status, expires_at, last_event_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [over.store ?? "apple", over.original ?? `${REF}-sub-${++counter}`, over.player ?? PLAYER, DEMO_PASS_MONTHLY, over.status ?? "active"],
    );

  it("enforces the store and status lists and the (store, original_ref) key", async () => {
    expect(await sub()).toBeNull();
    expect(await sub({ store: "amazon" })).toBe("store_subscriptions_store_check");
    for (const status of ["active", "grace", "billing_retry", "on_hold", "expired", "revoked"]) {
      expect(await sub({ status }), status).toBeNull();
    }
    expect(await sub({ status: "paused" })).toBe("store_subscriptions_status_check");
    const original = `${REF}-sub-key`;
    expect(await sub({ original })).toBeNull();
    expect(await sub({ original })).toBe("store_subscriptions_pk");
    expect(await sub({ original, player: OTHER })).toBe("store_subscriptions_pk");
  });

  it("the commerce token is random and unique, and everything of a player cascades with the player", async () => {
    await pool.query("INSERT INTO store_accounts (player_id) VALUES ($1), ($2)", [PLAYER, OTHER]);
    const { rows } = await pool.query<{ player_id: string; commerce_token: string }>(
      "SELECT player_id, commerce_token FROM store_accounts WHERE player_id = ANY($1) ORDER BY player_id",
      [[PLAYER, OTHER]],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.commerce_token)).size).toBe(2);
    const [first, second] = rows;
    expect(
      await violated("UPDATE store_accounts SET commerce_token = $1 WHERE player_id = $2", [first?.commerce_token, second?.player_id]),
    ).toBe("store_accounts_commerce_token_unique");

    const gone = `firebase:demo-airplane-games:store-schema-${randomUUID()}`;
    await pool.query("INSERT INTO players (id, created_at, updated_at) VALUES ($1, now(), now())", [gone]);
    await pool.query("INSERT INTO store_accounts (player_id) VALUES ($1)", [gone]);
    expect(await txn({ player: gone })).toBeNull();
    expect(await sub({ player: gone })).toBeNull();
    await pool.query("DELETE FROM players WHERE id = $1", [gone]);
    for (const table of ["store_accounts", "store_transactions", "store_subscriptions"]) {
      const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE player_id = $1`, [gone]);
      expect(rowCount, table).toBe(0);
    }
  });
});

describe("migration 0020: store_claims", () => {
  const claim = (over: { store?: string; kind?: string; ref?: string } = {}) =>
    violated("INSERT INTO store_claims (store, kind, ref) VALUES ($1, $2, $3)", [over.store ?? "apple", over.kind ?? "transaction", over.ref ?? `${REF}-claim-${++counter}`]);

  it("enforces the store and kind lists and the (store, kind, ref) key; the same ref is free under another kind or store", async () => {
    expect(await claim()).toBeNull();
    expect(await claim({ store: "amazon" })).toBe("store_claims_store_check");
    expect(await claim({ kind: "order" })).toBe("store_claims_kind_check");
    const ref = `${REF}-claim-key`;
    expect(await claim({ ref })).toBeNull();
    expect(await claim({ ref })).toBe("store_claims_pk");
    expect(await claim({ ref, kind: "subscription" })).toBeNull();
    expect(await claim({ ref, store: "google" })).toBeNull();
  });

  it("holds no player data and is never cascaded: there is no player column and no foreign key", async () => {
    const columns = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'store_claims' ORDER BY column_name",
    );
    expect(columns.rows.map((c) => c.column_name)).toEqual(["created_at", "kind", "ref", "store"]);
    const fks = await pool.query("SELECT 1 FROM pg_constraint WHERE conrelid = 'store_claims'::regclass AND contype = 'f'");
    expect(fks.rowCount).toBe(0);
  });
});

describe("migration 0020: ledger and audit lists", () => {
  it("hint_ledger accepts store_purchase and admin_audit accepts the four product actions, nothing else new", async () => {
    expect(
      await violated(
        "INSERT INTO hint_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, 5, 'store_purchase', $2, now())",
        [PLAYER, `apple:${REF}`],
      ),
    ).toBeNull();
    const audit = (action: string) =>
      violated("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ('test:seed', $1, $2, '{}'::jsonb, now())", [
        action,
        EXTRA,
      ]);
    for (const action of ["store_product_create", "store_product_edit", "store_product_retire", "store_product_restore"]) {
      expect(await audit(action), action).toBeNull();
    }
    expect(await audit("store_product_delete")).toBe("admin_audit_action_check");
  });
});

describe("test helper seedProduct", () => {
  it("resets an existing row to exactly the given values", async () => {
    await pool.query("DELETE FROM store_products WHERE product_id = $1", [EXTRA]);
    await seedProduct(pool, { productId: EXTRA, kind: "hint_pack", hints: 7, demo: true, status: "retired" });
    await seedProduct(pool, { productId: EXTRA, kind: "hint_pack", hints: 9 });
    const { rows } = await pool.query("SELECT hints, demo, status, version FROM store_products WHERE product_id = $1", [EXTRA]);
    expect(rows[0]).toEqual({ hints: 9, demo: false, status: "active", version: 1 });
  });
});
