import { Injectable } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { databaseNow } from "../database/clock.js";
import { rootCause } from "../database/database-errors.js";
import { DatabaseService } from "../database/database.module.js";
import { players, storeAccounts, storeSubscriptions } from "../db/schema.js";
import { hasFirstClassPass } from "../rules/first-class.js";

export type EntitlementsView = {
  commerceToken: string;
  firstClassPass: boolean;
  firstClassUntil: string | null;
  productId: string | null;
  evaluatedAt: string;
};

/** GET /v1/me/entitlements: the player's commerce token (created once) and First Class Pass state. A read: it never bumps the version. */
@Injectable()
export class EntitlementsService {
  constructor(private readonly database: DatabaseService) {}

  /** The view, or null when the player row does not exist. */
  async get(principal: string): Promise<EntitlementsView | null> {
    const { db } = this.database;
    const [player] = await db.select().from(players).where(eq(players.id, principal));
    if (!player) return null;

    // Create-once: the database default makes the random UUID; a race inserts nothing and both read the same row.
    try {
      await db.insert(storeAccounts).values({ playerId: principal }).onConflictDoNothing({ target: storeAccounts.playerId });
    } catch (error) {
      // The player was erased between the read and the insert (FK violation): same answer as no player.
      if ((rootCause(error) as { code?: unknown } | null)?.code === "23503") return null;
      throw error;
    }
    const [account] = await db.select().from(storeAccounts).where(eq(storeAccounts.playerId, principal));
    if (!account) return null;

    const evaluatedAt = await databaseNow(db);
    const firstClassPass = hasFirstClassPass(player.firstClassUntil, evaluatedAt);
    let productId: string | null = null;
    if (firstClassPass) {
      const [subscription] = await db
        .select({ productId: storeSubscriptions.productId })
        .from(storeSubscriptions)
        .where(and(eq(storeSubscriptions.playerId, principal), inArray(storeSubscriptions.status, ["active", "grace"])))
        .orderBy(desc(storeSubscriptions.expiresAt))
        .limit(1);
      productId = subscription?.productId ?? null;
    }
    return {
      commerceToken: account.commerceToken,
      firstClassPass,
      firstClassUntil: player.firstClassUntil?.toISOString() ?? null,
      productId,
      evaluatedAt: evaluatedAt.toISOString(),
    };
  }
}
