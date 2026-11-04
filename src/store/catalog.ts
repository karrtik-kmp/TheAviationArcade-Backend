import { eq } from "drizzle-orm";
import type { AppEnv } from "../config/config.module.js";
import type { Database, Tx } from "../database/database.module.js";
import { storeProducts } from "../db/schema.js";
import type { StoreProductRow } from "../db/schema.js";

/** The one catalog row type, as stored. */
export type StoreProduct = StoreProductRow;

/** The fields the two predicates read (so a caller holding a partial row can still ask). */
type Gateable = Pick<StoreProductRow, "status" | "demo">;

/** One catalog row by store product id, or null. Pass the transaction handle to read inside `PlayerBalance.update`. */
export async function findProduct(db: Database | Tx, productId: string): Promise<StoreProduct | null> {
  const [row] = await db.select().from(storeProducts).where(eq(storeProducts.productId, productId)).limit(1);
  return row ?? null;
}

/**
 * May a verified store purchase of this product be granted here? Active or retired (an old receipt is honoured after staff
 * retire a product), but never a demo product in production: demo rows carry placeholder store ids.
 */
export function isSellable(product: Gateable, appEnv: AppEnv): boolean {
  return !(product.demo && appEnv === "production");
}

/** Is the product offered to players (`GET /v1/store/products`)? Active, and not a demo product in production. */
export function isListed(product: Gateable, appEnv: AppEnv): boolean {
  return product.status === "active" && isSellable(product, appEnv);
}
