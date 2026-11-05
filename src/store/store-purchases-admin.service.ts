import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { createHash } from "node:crypto";
import { ApiError } from "../common/errors.js";
import { databaseNow } from "../database/clock.js";
import { DatabaseService } from "../database/database.module.js";
import type { StoreEnvironment, StoreName, StoreProductKind, StoreSubscriptionStatus } from "../db/enums.js";
import { players, storeAccounts, storeSubscriptions, storeTransactions } from "../db/schema.js";
import type { StoreTransactionRow } from "../db/schema.js";
import { hasFirstClassPass } from "../rules/first-class.js";

/** One consistent snapshot, no writes: the same read-only level as the content admin. */
const READ_SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

export type PurchaseFilters = {
  player?: string | undefined;
  productId?: string | undefined;
  store?: StoreName | undefined;
  transactionRef?: string | undefined;
  orderId?: string | undefined;
};

/** What was granted. Closed per contract version (a new type arrives with a version bump); a consumer still shows an unknown type raw. */
export type StaffGrant = { type: "hints"; hints: number } | { type: "miles"; miles: number } | { type: "first_class_pass"; until: string };

export type StaffStorePurchase = {
  id: number;
  store: StoreName;
  principal: string;
  productId: string;
  kind: StoreProductKind;
  environment: StoreEnvironment;
  transactionId: string | null;
  originalTransactionId: string | null;
  orderId: string | null;
  tokenFingerprint: string | null;
  originalFingerprint: string | null;
  purchasedAt: string;
  grant: StaffGrant;
  createdAt: string;
};

export type StaffStorePurchaseList = { purchases: StaffStorePurchase[]; nextCursor: string | null };

export type StaffStoreSubscription = {
  store: StoreName;
  originalTransactionId: string | null;
  originalFingerprint: string | null;
  productId: string;
  status: StoreSubscriptionStatus;
  expiresAt: string;
  lastEventAt: string;
  createdAt: string;
};

export type StaffEntitlements = {
  principal: string;
  firstClassPass: boolean;
  firstClassUntil: string | null;
  productId: string | null;
  evaluatedAt: string;
  hasStoreAccount: boolean;
  subscriptions: StaffStoreSubscription[];
};

/** First 12 hex digits of SHA-256: enough to match a row to a store console entry, useless as a credential. */
export const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 12);

/** First 22 base64url characters of SHA-256 over the canonical filter list: the filters a cursor was made under. */
function filterDigest(filters: PurchaseFilters): string {
  const canonical = JSON.stringify([
    filters.player ?? null,
    filters.productId ?? null,
    filters.store ?? null,
    filters.transactionRef ?? null,
    filters.orderId ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 22);
}

const CURSOR = /^sp1\.([1-9][0-9]{0,14})\.([A-Za-z0-9_-]{22})$/;

/** Opaque to clients: base64url of `sp1.<last id>.<filter digest>`. */
function encodeCursor(lastId: number, digest: string): string {
  return Buffer.from(`sp1.${lastId}.${digest}`).toString("base64url");
}

/** The last id, or undefined when the text is not a cursor made under these filters (or is a non-canonical spelling). */
function decodeCursor(cursor: string, digest: string): number | undefined {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(cursor)) return undefined;
  const match = CURSOR.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match || match[2] !== digest) return undefined;
  const id = Number(match[1]);
  return encodeCursor(id, digest) === cursor ? id : undefined;
}

/**
 * The fake store's references embed the buyer's account token (the commerce token) as a segment:
 * `fake~<outcome>~<productId>~<token|none>~<sec>[~<sec>]` and `fake~<productId>~<token|none>`. Staff never see that token, so the segment is
 * replaced by its fingerprint. Real store references are returned as stored.
 */
function maskFakeRef(ref: string | null): string | null {
  if (ref === null || !ref.startsWith("fake~")) return ref;
  const parts = ref.split("~");
  const at = parts.length === 3 ? 2 : parts.length === 5 || parts.length === 6 ? 3 : -1;
  if (at === -1) return fingerprint(ref); // malformed (cannot be stored by the fake verifier): show nothing raw
  if (parts[at] !== "none") parts[at] = fingerprint(parts[at] as string);
  return parts.join("~");
}

function grantOf(row: StoreTransactionRow): StaffGrant {
  const kind = row.kind;
  switch (kind) {
    case "hint_pack":
      return { type: "hints", hints: row.grantedHints as number };
    case "miles_pack":
      return { type: "miles", miles: row.grantedMiles as number };
    case "first_class_pass":
      return { type: "first_class_pass", until: (row.grantedUntil as Date).toISOString() };
    default: {
      const unhandled: never = kind;
      throw new Error(`No staff grant mapping for kind ${String(unhandled)}`);
    }
  }
}

/** A consumable (hint or Miles pack) has no chain: its Google transaction reference is the purchase token. A Pass is not. */
function isConsumable(kind: StoreProductKind): boolean {
  switch (kind) {
    case "hint_pack":
    case "miles_pack":
      return true;
    case "first_class_pass":
      return false;
    default: {
      const unhandled: never = kind;
      throw new Error(`No consumable rule for kind ${String(unhandled)}`);
    }
  }
}

function purchaseView(row: StoreTransactionRow): StaffStorePurchase {
  const apple = row.store === "apple";
  const grant = grantOf(row);
  return {
    id: row.id,
    store: row.store,
    principal: row.playerId,
    productId: row.productId,
    kind: row.kind,
    environment: row.environment,
    transactionId: apple ? maskFakeRef(row.transactionRef) : null,
    originalTransactionId: apple ? maskFakeRef(row.originalRef) : null,
    orderId: row.orderId,
    // Google one-time (hint or Miles pack): the transaction reference is the purchase token. A Google Pass transaction reference is an order id, so only
    // the chain's first token (`original_ref`) is fingerprinted. The raw token is never returned.
    tokenFingerprint: !apple && isConsumable(row.kind) ? fingerprint(row.transactionRef) : null,
    originalFingerprint: !apple && row.originalRef !== null ? fingerprint(row.originalRef) : null,
    purchasedAt: row.purchasedAt.toISOString(),
    grant,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Staff read of store purchases and entitlements (plan wave P-D). Read only: no balance write, no token created. */
@Injectable()
export class StorePurchasesAdminService {
  constructor(private readonly database: DatabaseService) {}

  /** One page, newest first by id (insert order). The cursor names the last id and the filters it was made under; anything else is 400. */
  async listPurchases(filters: PurchaseFilters, cursor: string | undefined, limit: number): Promise<StaffStorePurchaseList> {
    const digest = filterDigest(filters);
    let before: number | undefined;
    if (cursor !== undefined) {
      before = decodeCursor(cursor, digest);
      if (before === undefined) {
        throw new ApiError(400, "invalid_request", "Not a cursor this route returned (or the filters changed). Start again without cursor.");
      }
    }
    const rows = await this.database.db
      .select()
      .from(storeTransactions)
      .where(
        and(
          filters.player === undefined ? undefined : eq(storeTransactions.playerId, filters.player),
          filters.productId === undefined ? undefined : eq(storeTransactions.productId, filters.productId),
          filters.store === undefined ? undefined : eq(storeTransactions.store, filters.store),
          filters.transactionRef === undefined ? undefined : eq(storeTransactions.transactionRef, filters.transactionRef),
          filters.orderId === undefined ? undefined : eq(storeTransactions.orderId, filters.orderId),
          before === undefined ? undefined : lt(storeTransactions.id, before),
        ),
      )
      .orderBy(desc(storeTransactions.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      purchases: page.map(purchaseView),
      nextCursor: rows.length > limit && last ? encodeCursor(last.id, digest) : null,
    };
  }

  /**
   * The player's Pass state and subscriptions in one read-only snapshot. Never `EntitlementsService.get`: that creates the
   * commerce token row, and a staff read must change nothing. Null when the player does not exist.
   */
  async entitlements(principal: string): Promise<StaffEntitlements | null> {
    return this.database.withTransaction(async (tx) => {
      const [player] = await tx.select().from(players).where(eq(players.id, principal));
      if (!player) return null;
      const subscriptions = await tx
        .select()
        .from(storeSubscriptions)
        .where(eq(storeSubscriptions.playerId, principal))
        .orderBy(desc(storeSubscriptions.expiresAt), asc(storeSubscriptions.originalRef), asc(storeSubscriptions.store));
      const [account] = await tx.select({ playerId: storeAccounts.playerId }).from(storeAccounts).where(eq(storeAccounts.playerId, principal));
      const evaluatedAt = await databaseNow(tx);
      const firstClassPass = hasFirstClassPass(player.firstClassUntil, evaluatedAt);
      let productId: string | null = null;
      if (firstClassPass) {
        const [current] = await tx
          .select({ productId: storeSubscriptions.productId })
          .from(storeSubscriptions)
          .where(and(eq(storeSubscriptions.playerId, principal), inArray(storeSubscriptions.status, ["active", "grace"])))
          .orderBy(desc(storeSubscriptions.expiresAt))
          .limit(1);
        productId = current?.productId ?? null;
      }
      return {
        principal,
        firstClassPass,
        firstClassUntil: player.firstClassUntil?.toISOString() ?? null,
        productId,
        evaluatedAt: evaluatedAt.toISOString(),
        hasStoreAccount: account !== undefined,
        subscriptions: subscriptions.map((s) => ({
          store: s.store,
          originalTransactionId: s.store === "apple" ? maskFakeRef(s.originalRef) : null,
          originalFingerprint: s.store === "google" ? fingerprint(s.originalRef) : null,
          productId: s.productId,
          status: s.status,
          expiresAt: s.expiresAt.toISOString(),
          lastEventAt: s.lastEventAt.toISOString(),
          createdAt: s.createdAt.toISOString(),
        })),
      };
    }, READ_SNAPSHOT);
  }
}
