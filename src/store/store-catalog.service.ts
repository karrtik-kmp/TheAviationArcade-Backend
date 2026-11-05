import { Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { ApiError } from "../common/errors.js";
import type { AppEnv } from "../config/config.module.js";
import { databaseNow } from "../database/clock.js";
import { DatabaseService } from "../database/database.module.js";
import type { Tx } from "../database/database.module.js";
import type { AdminAuditAction, StorePassPeriod, StoreProductKind } from "../db/enums.js";
import { adminAudit, storeProducts } from "../db/schema.js";
import type { StoreProductRow } from "../db/schema.js";
import { isListed } from "./catalog.js";

export type ListedProduct = { productId: string; kind: StoreProductKind; hints?: number; miles?: number; passPeriod?: StorePassPeriod };

export type AdminProduct = {
  productId: string;
  kind: StoreProductKind;
  hints: number | null;
  miles: number | null;
  passPeriod: StorePassPeriod | null;
  title: string;
  demo: boolean;
  status: StoreProductRow["status"];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ProductWrite = {
  kind: StoreProductKind;
  title: string;
  hints?: number | undefined;
  miles?: number | undefined;
  passPeriod?: StorePassPeriod | undefined;
  demo: boolean;
};

type Field = { field: string; from: unknown; to: unknown };
type Outcome = { ok: true; created: boolean; row: StoreProductRow } | { ok: false; error: ApiError };

export function adminView(row: StoreProductRow): AdminProduct {
  return {
    productId: row.productId,
    kind: row.kind,
    hints: row.hints,
    miles: row.miles,
    passPeriod: row.passPeriod,
    title: row.title,
    demo: row.demo,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function listedView(row: StoreProductRow): ListedProduct {
  return {
    productId: row.productId,
    kind: row.kind,
    ...(row.hints !== null ? { hints: row.hints } : {}),
    ...(row.miles !== null ? { miles: row.miles } : {}),
    ...(row.passPeriod !== null ? { passPeriod: row.passPeriod } : {}),
  };
}

const conflict = (stored: number) =>
  new ApiError(409, "version_conflict", `The product is at version ${stored}. Reload it and apply the change again. Nothing was changed.`);
const notFound = () => new ApiError(404, "not_found", "No such product.");

/**
 * Staff catalog writes (create, edit, retire, restore) and the player listing. One transaction per write, the row locked,
 * one admin_audit row per real change, stamped with one database instant. A request that changes nothing writes nothing.
 */
@Injectable()
export class StoreCatalogService {
  constructor(private readonly database: DatabaseService) {}

  /** Active products, minus demo products in production. No title, no price. Stable order by id. */
  async listListed(appEnv: AppEnv): Promise<ListedProduct[]> {
    const rows = await this.database.db.select().from(storeProducts).orderBy(asc(storeProducts.productId));
    return rows.filter((row) => isListed(row, appEnv)).map(listedView);
  }

  async listAll(): Promise<AdminProduct[]> {
    const rows = await this.database.db.select().from(storeProducts).orderBy(asc(storeProducts.productId));
    return rows.map(adminView);
  }

  /** No `version` creates (`created: true`); with `version` it edits. See the contract (PUT /v1/admin/store/products/{productId}). */
  async put(
    principal: string,
    productId: string,
    version: number | undefined,
    body: ProductWrite,
    appEnv: AppEnv,
  ): Promise<{ created: boolean; product: AdminProduct }> {
    switch (body.kind) {
      case "hint_pack":
        if (body.hints === undefined || body.miles !== undefined || body.passPeriod !== undefined) {
          throw new ApiError(422, "content_invalid", "A hint pack needs hints (1 to 1000) and no miles or passPeriod. Nothing was changed.");
        }
        break;
      case "miles_pack":
        if (body.miles === undefined || body.hints !== undefined || body.passPeriod !== undefined) {
          throw new ApiError(422, "content_invalid", "A Miles pack needs miles (1 to 1000000) and no hints or passPeriod. Nothing was changed.");
        }
        break;
      case "first_class_pass":
        if (body.passPeriod === undefined || body.hints !== undefined || body.miles !== undefined) {
          throw new ApiError(422, "content_invalid", "A First Class Pass needs passPeriod and no hints or miles. Nothing was changed.");
        }
        break;
      default: {
        const unhandled: never = body.kind;
        throw new Error(`No pairing rule for kind ${String(unhandled)}`);
      }
    }
    if (version === undefined && body.demo && appEnv === "production") {
      throw new ApiError(422, "content_invalid", "A demo product cannot be created in production. Nothing was changed.");
    }
    const hints = body.hints ?? null;
    const miles = body.miles ?? null;
    const passPeriod = body.passPeriod ?? null;
    // Expected refusals are returned, not thrown, so the connection goes back to the pool instead of being destroyed.
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome> => {
      const now = await databaseNow(tx);
      if (version === undefined) {
        const [inserted] = await tx
          .insert(storeProducts)
          .values({ productId, kind: body.kind, hints, miles, passPeriod, title: body.title, demo: body.demo, status: "active", createdAt: now, updatedAt: now })
          .onConflictDoNothing()
          .returning();
        if (!inserted) {
          const [existing] = await tx.select({ version: storeProducts.version }).from(storeProducts).where(eq(storeProducts.productId, productId));
          return { ok: false, error: conflict(existing?.version ?? 0) };
        }
        await this.audit(tx, principal, "store_product_create", productId, now, {
          version: 1,
          kind: body.kind,
          title: body.title,
          hints,
          miles,
          passPeriod,
          demo: body.demo,
        });
        return { ok: true, created: true, row: inserted };
      }
      const [stored] = await tx.select().from(storeProducts).where(eq(storeProducts.productId, productId)).for("update");
      if (!stored) return { ok: false, error: notFound() };
      if (stored.version !== version) return { ok: false, error: conflict(stored.version) };
      if (stored.kind !== body.kind) {
        return { ok: false, error: new ApiError(422, "content_invalid", "The kind of an existing product cannot change. Nothing was changed.") };
      }
      if (stored.demo !== body.demo) {
        return { ok: false, error: new ApiError(422, "content_invalid", "The demo flag of an existing product cannot change. Nothing was changed.") };
      }
      const diff: Field[] = [];
      if (stored.title !== body.title) diff.push({ field: "title", from: stored.title, to: body.title });
      if (stored.hints !== hints) diff.push({ field: "hints", from: stored.hints, to: hints });
      if (stored.miles !== miles) diff.push({ field: "miles", from: stored.miles, to: miles });
      if (stored.passPeriod !== passPeriod) diff.push({ field: "passPeriod", from: stored.passPeriod, to: passPeriod });
      if (diff.length === 0) return { ok: true, created: false, row: stored };
      const [row] = await tx
        .update(storeProducts)
        .set({ title: body.title, hints, miles, passPeriod, version: sql`${storeProducts.version} + 1`, updatedAt: now })
        .where(and(eq(storeProducts.productId, productId), eq(storeProducts.version, stored.version)))
        .returning();
      if (!row) throw new Error("Product update was not stored."); // the row lock makes this unreachable
      await this.audit(tx, principal, "store_product_edit", productId, now, { fromVersion: stored.version, version: row.version, diff });
      return { ok: true, created: false, row };
    });
    if (!outcome.ok) throw outcome.error;
    return { created: outcome.created, product: adminView(outcome.row) };
  }

  /** retire → `retired`, restore → `active`. Already in that state: no change (the version is still checked). */
  async setStatus(principal: string, productId: string, version: number, status: "active" | "retired"): Promise<AdminProduct> {
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome> => {
      const [stored] = await tx.select().from(storeProducts).where(eq(storeProducts.productId, productId)).for("update");
      if (!stored) return { ok: false, error: notFound() };
      if (stored.version !== version) return { ok: false, error: conflict(stored.version) };
      if (stored.status === status) return { ok: true, created: false, row: stored };
      const now = await databaseNow(tx);
      const [row] = await tx
        .update(storeProducts)
        .set({ status, version: sql`${storeProducts.version} + 1`, updatedAt: now })
        .where(and(eq(storeProducts.productId, productId), eq(storeProducts.version, stored.version)))
        .returning();
      if (!row) throw new Error("Product update was not stored."); // the row lock makes this unreachable
      await this.audit(tx, principal, status === "retired" ? "store_product_retire" : "store_product_restore", productId, now, {
        fromVersion: stored.version,
        version: row.version,
        diff: [{ field: "status", from: stored.status, to: status }],
      });
      return { ok: true, created: false, row };
    });
    if (!outcome.ok) throw outcome.error;
    return adminView(outcome.row);
  }

  private async audit(tx: Tx, actor: string, action: AdminAuditAction, target: string, createdAt: Date, detail: Record<string, unknown>): Promise<void> {
    await tx.insert(adminAudit).values({ actor, action, target, detail, createdAt });
  }
}
