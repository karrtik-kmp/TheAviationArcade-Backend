import type pg from "pg";
import type { StorePassPeriod, StoreProductKind, StoreProductStatus } from "../src/db/enums.js";
import { DEMO_PRODUCTS } from "../src/store/demo-products.js";
import type { DemoProduct } from "../src/store/demo-products.js";

// e2e helpers for the store catalog (docs/plans/purchases.md). Products are never deleted by the app (transactions reference
// them), and the e2e database is shared across files and runs, so seeding is an upsert back to a known state.

/** The four seeded demo ids (user ruling R1). */
export const DEMO_HINT_5 = "aa.hints.5";
export const DEMO_HINT_15 = "aa.hints.15";
export const DEMO_PASS_MONTHLY = "aa.firstclass.monthly";
export const DEMO_PASS_YEARLY = "aa.firstclass.yearly";

export type ProductSeed = {
  productId: string;
  kind: StoreProductKind;
  hints?: number | null;
  passPeriod?: StorePassPeriod | null;
  title?: string;
  demo?: boolean;
  status?: StoreProductStatus;
};

/** Insert or reset one product to exactly these values (version back to 1). Defaults: not demo, active, the id as title. */
export async function seedProduct(sql: pg.Pool | pg.Client, product: ProductSeed): Promise<void> {
  await sql.query(
    `INSERT INTO store_products (product_id, kind, hints, pass_period, title, demo, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (product_id) DO UPDATE SET kind = EXCLUDED.kind, hints = EXCLUDED.hints, pass_period = EXCLUDED.pass_period,
       title = EXCLUDED.title, demo = EXCLUDED.demo, status = EXCLUDED.status, version = 1, updated_at = now()`,
    [
      product.productId,
      product.kind,
      product.hints ?? null,
      product.passPeriod ?? null,
      product.title ?? product.productId,
      product.demo ?? false,
      product.status ?? "active",
    ],
  );
}

/** Insert or reset the four demo products from src/store/demo-products.ts to their seeded state. */
export async function seedDemoProducts(sql: pg.Pool | pg.Client): Promise<void> {
  for (const product of DEMO_PRODUCTS) await seedProduct(sql, product);
}

/** One seeded demo product by id (throws on an unknown id, so a typo cannot pass silently). */
export function demoProduct(productId: string): DemoProduct {
  const found = DEMO_PRODUCTS.find((p) => p.productId === productId);
  if (!found) throw new Error(`no demo product ${productId}`);
  return found;
}
