import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { Tx } from "../database/database.module.js";
import { storeClaims, storeSubscriptions, storeTransactions } from "../db/schema.js";
import type { StoreTransactionRow } from "../db/schema.js";
import type { StoreClaimKind, StoreName } from "../db/enums.js";
import type { StoreProduct } from "../store/catalog.js";
import type { VerifiedTransaction } from "./store-verifier.js";

/**
 * The ONLY writer of store_transactions, store_subscriptions and store_claims (test/balance-guard.test.ts). Every function takes the open
 * transaction of `PlayerBalance.update`, so the player row is already locked: order under the lock is transactions, then
 * subscriptions, then the firstClassUntil recompute. No network, no clock (`now` is the database instant of the call).
 */

export type ClaimResult =
  | { kind: "new"; row: StoreTransactionRow }
  | { kind: "replay"; row: StoreTransactionRow }
  | { kind: "other" }
  /** A new row was inserted but the reference was granted before (to a player since deleted): the caller rolls the row back. */
  | { kind: "remembered" };

/**
 * Record the transaction under UNIQUE (store, transaction_ref). A reference another player already holds writes nothing
 * (`other`); the same player's earlier row is a replay. The snapshot (granted hints / Miles / until) comes from the catalog row as read
 * under the lock, so a later catalog edit never changes it.
 */
export async function claimTransaction(
  tx: Tx,
  input: { playerId: string; product: StoreProduct; transaction: VerifiedTransaction; now: Date },
): Promise<ClaimResult> {
  const { playerId, product, transaction, now } = input;
  const isPass = product.kind === "first_class_pass";
  let grantedHints: number | null = null;
  let grantedMiles: number | null = null;
  switch (product.kind) {
    case "hint_pack":
      if (product.hints === null) throw new Error(`Hint pack ${product.productId} has no hint count.`);
      grantedHints = product.hints;
      break;
    case "miles_pack":
      if (product.miles === null) throw new Error(`Miles pack ${product.productId} has no Miles amount.`);
      grantedMiles = product.miles;
      break;
    case "first_class_pass":
      break;
    default: {
      const unhandled: never = product.kind;
      throw new Error(`No grant snapshot for kind ${String(unhandled)}`);
    }
  }
  const [inserted] = await tx
    .insert(storeTransactions)
    .values({
      store: transaction.store,
      transactionRef: transaction.transactionRef,
      playerId,
      productId: product.productId,
      kind: product.kind,
      environment: transaction.environment,
      orderId: transaction.orderId,
      originalRef: isPass ? transaction.originalRef : null,
      purchasedAt: transaction.purchasedAt,
      grantedHints,
      grantedMiles,
      grantedUntil: isPass ? transaction.expiresAt : null,
      createdAt: now,
    })
    .onConflictDoNothing({ target: [storeTransactions.store, storeTransactions.transactionRef] })
    .returning();
  if (inserted) {
    // Account deletion removes the purchase rows but never this tombstone: a reference seen before can never be granted again.
    const claimed = await rememberClaim(tx, transaction.store, "transaction", transaction.transactionRef, now);
    return claimed ? { kind: "new", row: inserted } : { kind: "remembered" };
  }

  const [existing] = await tx
    .select()
    .from(storeTransactions)
    .where(and(eq(storeTransactions.store, transaction.store), eq(storeTransactions.transactionRef, transaction.transactionRef)));
  // The conflicting row was committed (that is what DO NOTHING waits for); it can only vanish if its player was just erased.
  if (!existing) throw new Error("Store transaction vanished after a conflict.");
  return existing.playerId === playerId ? { kind: "replay", row: existing } : { kind: "other" };
}

/** Insert the tombstone; false when it already exists (an earlier owner was deleted). */
async function rememberClaim(tx: Tx, store: StoreName, kind: StoreClaimKind, ref: string, now: Date): Promise<boolean> {
  const rows = await tx
    .insert(storeClaims)
    .values({ store, kind, ref, createdAt: now })
    .onConflictDoNothing({ target: [storeClaims.store, storeClaims.kind, storeClaims.ref] })
    .returning({ ref: storeClaims.ref });
  return rows.length === 1;
}

/**
 * Upsert the Pass subscription chain: a renewal raises `expires_at` (never lowers it) and sets the status back to `active`. The
 * owner is set once: a chain held by another player updates nothing, and a NEW chain whose reference was granted before (to a
 * player since deleted) is refused; both answer false and the caller rolls the transaction row back. A renewal of the caller's own
 * chain never touches store_claims.
 */
export async function claimSubscription(
  tx: Tx,
  input: { playerId: string; product: StoreProduct; transaction: VerifiedTransaction; expiresAt: Date; now: Date },
): Promise<boolean> {
  const { playerId, product, transaction, expiresAt, now } = input;
  if (!transaction.originalRef) throw new Error("A Pass transaction needs an original reference.");
  const rows = await tx
    .insert(storeSubscriptions)
    .values({
      store: transaction.store,
      originalRef: transaction.originalRef,
      playerId,
      productId: product.productId,
      status: "active",
      expiresAt,
      lastEventAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [storeSubscriptions.store, storeSubscriptions.originalRef],
      set: {
        expiresAt: sql`GREATEST(${storeSubscriptions.expiresAt}, excluded.expires_at)`,
        status: "active",
        lastEventAt: sql`GREATEST(${storeSubscriptions.lastEventAt}, excluded.last_event_at)`,
        updatedAt: now,
      },
      setWhere: sql`${storeSubscriptions.playerId} = excluded.player_id`,
    })
    .returning({ playerId: storeSubscriptions.playerId, created: sql<boolean>`(xmax = 0)` });
  const [row] = rows;
  if (!row) return false;
  if (!row.created) return true;
  return rememberClaim(tx, transaction.store, "subscription", transaction.originalRef, now);
}

/** The player's First Class expiry: the latest `expires_at` over their `active` and `grace` subscriptions, or null. */
export async function recomputeFirstClassUntil(tx: Tx, playerId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ until: max(storeSubscriptions.expiresAt) })
    .from(storeSubscriptions)
    .where(and(eq(storeSubscriptions.playerId, playerId), inArray(storeSubscriptions.status, ["active", "grace"])));
  return row?.until ?? null;
}
