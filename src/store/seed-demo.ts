import { sql } from "drizzle-orm";
import type { AppEnv } from "../config/config.module.js";
import type { Database, Tx } from "../database/database.module.js";
import { storeProducts } from "../db/schema.js";
import { DEMO_PRODUCTS } from "./demo-products.js";
import type { DemoProduct } from "./demo-products.js";

/**
 * Insert the demo catalog rows that are missing (`npm run store:seed-demo`). Never edits an existing row, so staff changes
 * survive a re-run. Refused in production: demo rows carry placeholder store ids. Returns the ids it inserted. `products` is the
 * list to seed (always `DEMO_PRODUCTS` outside tests, which pass fresh ids to exercise the insert path on any database state).
 */
export async function seedDemoCatalog(db: Database | Tx, appEnv: AppEnv, products: readonly DemoProduct[] = DEMO_PRODUCTS): Promise<string[]> {
  if (appEnv === "production") throw new Error("The demo catalog cannot be seeded when APP_ENV=production.");
  const inserted = await db
    .insert(storeProducts)
    .values(products.map((p) => ({ ...p })))
    .onConflictDoNothing()
    .returning({ productId: storeProducts.productId });
  return inserted.map((r) => r.productId);
}

/** Number of active demo products in the database (the production start warning). */
export async function countActiveDemoProducts(db: Database | Tx): Promise<number> {
  const result = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM store_products WHERE demo AND status = 'active'`);
  return Number(result.rows[0]?.n ?? 0);
}
