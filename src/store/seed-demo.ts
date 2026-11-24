import { sql } from "drizzle-orm";
import type { AppEnv } from "../config/config.module.js";
import type { Database, Tx } from "../database/database.module.js";
import { databaseNow } from "../database/clock.js";
import { adminAudit, storeProducts } from "../db/schema.js";
import { DEMO_PRODUCTS } from "./demo-products.js";
import type { DemoProduct } from "./demo-products.js";

/**
 * Insert the demo catalog rows that are missing (`npm run store:seed-demo`). Never edits an existing row, so staff changes
 * survive a re-run. Refused in production: demo rows carry placeholder store ids. Returns the ids it inserted. `products` is the
 * list to seed (always `DEMO_PRODUCTS` outside tests, which pass fresh ids to exercise the insert path on any database state).
 */
export async function seedDemoCatalog(
  db: Database | Tx,
  appEnv: AppEnv,
  operator: string,
  products: readonly DemoProduct[] = DEMO_PRODUCTS,
): Promise<string[]> {
  if (appEnv === "production") throw new Error("The demo catalog cannot be seeded when APP_ENV=production.");
  const actor = `operator:${operator}`.slice(0, 256);
  const run = async (tx: Tx): Promise<string[]> => {
    // One database-clock instant for the rows and their audit, as StoreCatalogService.put does (not the transaction-start now() default).
    const now = await databaseNow(tx);
    const inserted = await tx
      .insert(storeProducts)
      .values(products.map((p) => ({ ...p, createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now })))
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) {
      // One store_product_create audit row per row actually inserted, the same detail shape as StoreCatalogService.put.
      await tx.insert(adminAudit).values(
        inserted.map((row) => ({
          actor,
          action: "store_product_create" as const,
          target: row.productId,
          detail: { version: 1, kind: row.kind, title: row.title, hints: row.hints, miles: row.miles, passPeriod: row.passPeriod, demo: row.demo },
          createdAt: now,
        })),
      );
    }
    return inserted.map((r) => r.productId);
  };
  // Rows and audit land together: on a Database this opens a transaction, on a caller's Tx a savepoint (the caller owns the commit).
  return db.transaction(run);
}

/** Number of active demo products in the database (the production start warning). */
export async function countActiveDemoProducts(db: Database | Tx): Promise<number> {
  const result = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM store_products WHERE demo AND status = 'active'`);
  return Number(result.rows[0]?.n ?? 0);
}
