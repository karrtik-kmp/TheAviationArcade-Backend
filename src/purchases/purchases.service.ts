import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { PlayerBalance } from "../balance/player-balance.js";
import type { BalanceChange } from "../balance/player-balance.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { rootCause } from "../database/database-errors.js";
import { DatabaseService, ExpectedRollback } from "../database/database.module.js";
import { players, storeAccounts } from "../db/schema.js";
import type { PlayerRow, StoreTransactionRow } from "../db/schema.js";
import { findProduct, isSellable } from "../store/catalog.js";
import type { LivePlayer } from "../trips/trip-store.js";
import { withLiveStreak } from "../trips/trip-store.js";
import { claimSubscription, claimTransaction, recomputeFirstClassUntil } from "./purchase-grant.js";
import { normalizeAccountToken, STORE_VERIFIER } from "./store-verifier.js";
import type { StoreReference, StoreVerifier, VerifiedTransaction } from "./store-verifier.js";

/** The store calls are bounded: a hung store becomes a 503 the app retries, never a held request. */
const VERIFY_TIMEOUT_MS = 8000;
const ACKNOWLEDGE_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_AFTER_SEC = 10;
const MAX_RETRY_AFTER_SEC = 3600;

export type PurchaseOutcome =
  | { kind: "no_player" }
  | { kind: "unavailable"; retryAfterSec: number }
  | { kind: "invalid" }
  | { kind: "revoked" }
  | { kind: "owned_by_other" }
  | { kind: "pending"; player: LivePlayer }
  | { kind: "granted"; replayed: boolean; record: StoreTransactionRow; player: LivePlayer };

/** What the transaction callback decides; everything but `granted` wrote nothing. */
type Decision =
  | { kind: "pending" }
  | { kind: "invalid" }
  | { kind: "owned_by_other" }
  | { kind: "granted"; replayed: boolean; record: StoreTransactionRow };

/** Undo the transaction row inserted a moment ago, and carry the decision out (the connection is kept, not destroyed). */
class PurchaseRollback extends ExpectedRollback {
  constructor(readonly decision: Decision) {
    super("Purchase rolled back.");
  }
}

/** The unique constraints that mean "this store reference is already taken"; any other violation is a bug and stays a 500. */
const REFERENCE_CONSTRAINTS: ReadonlySet<string> = new Set(["store_transactions_store_ref", "store_subscriptions_pk", "store_claims_pk"]);

export function isReferenceConflict(error: unknown): boolean {
  const root = rootCause(error) as { code?: unknown; constraint?: unknown } | null;
  return root?.code === "23505" && typeof root.constraint === "string" && REFERENCE_CONSTRAINTS.has(root.constraint);
}

function retryAfterSeconds(retryAfterMs: number | undefined): number {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return DEFAULT_RETRY_AFTER_SEC;
  return Math.min(MAX_RETRY_AFTER_SEC, Math.max(1, Math.ceil(retryAfterMs / 1000)));
}

/**
 * POST /v1/purchases. The store is asked first, outside any transaction; the grant is then ONE PlayerBalance.update (player
 * row locked first) whose callback calls the writers in purchase-grant.ts. Pending, owned-by-other and replay come back as
 * values, so no error unwinds the pooled connection; a rollback with a value (ExpectedRollback) undoes the one case where an
 * earlier insert must not stay.
 */
@Injectable()
export class PurchasesService implements OnModuleDestroy {
  private readonly logger = new Logger("Purchases");

  constructor(
    private readonly balance: PlayerBalance,
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(STORE_VERIFIER) private readonly verifier: StoreVerifier,
  ) {}

  async submit(principal: string, reference: StoreReference): Promise<PurchaseOutcome> {
    const [existing] = await this.database.db.select().from(players).where(eq(players.id, principal));
    if (!existing) return { kind: "no_player" };

    // The catalog kind tells the adapter which store endpoint to ask. Read without a lock, outside any transaction; `kind` is
    // immutable after create, and `grant` re-reads the product inside the transaction. An unknown or unsellable product is
    // pending before any store call, for both stores (nothing is written, the app keeps it).
    const catalogProduct = await findProduct(this.database.db, reference.productId);
    if (!catalogProduct || !isSellable(catalogProduct, this.config.appEnv)) {
      return { kind: "pending", player: await withLiveStreak(this.database.db, existing) };
    }

    let verified;
    try {
      verified = await this.verifier.verify(reference, { kind: catalogProduct.kind }, AbortSignal.timeout(VERIFY_TIMEOUT_MS));
    } catch (error) {
      // An adapter that throws is a store we could not ask: transient, nothing written. The message is not logged (it can quote input).
      this.logger.warn(`store verify failed (${error instanceof Error ? error.constructor.name : typeof error}); adapters must return results`);
      return { kind: "unavailable", retryAfterSec: DEFAULT_RETRY_AFTER_SEC };
    }
    if (verified.kind === "transient") return { kind: "unavailable", retryAfterSec: retryAfterSeconds(verified.retryAfterMs) };
    if (verified.kind === "invalid") return { kind: "invalid" };
    const transaction = verified.transaction;
    if (transaction.productId !== reference.productId || transaction.store !== reference.store) return { kind: "invalid" };
    if (transaction.revoked) return { kind: "revoked" };

    let decision: Decision;
    let player: PlayerRow | null;
    try {
      const result = await this.balance.update<Decision>(principal, (locked) => this.grant(locked, transaction));
      if (result.kind === "no_player") return { kind: "no_player" };
      if (result.kind === "insufficient") throw new Error("A purchase grant cannot be insufficient.");
      decision = result.value;
      player = result.player;
    } catch (error) {
      if (error instanceof PurchaseRollback) {
        decision = error.decision;
        player = null;
      } else if (isReferenceConflict(error)) {
        // A residual unique violation on a store reference (a claim that raced past the checks): it belongs to someone else.
        decision = { kind: "owned_by_other" };
        player = null;
      } else {
        throw error;
      }
    }

    if (decision.kind === "invalid") return { kind: "invalid" };
    if (decision.kind === "owned_by_other") return { kind: "owned_by_other" };
    if (!player) throw new Error("Player row missing after a purchase.");
    const live = await withLiveStreak(this.database.db, player);
    if (decision.kind === "pending") return { kind: "pending", player: live };

    // Google wants the purchase acknowledged; also on a replay (skipped when the store already reports it acknowledged).
    if (transaction.store === "google") await this.acknowledge(transaction);
    return { kind: "granted", replayed: decision.replayed, record: decision.record, player: live };
  }

  private async grant(
    locked: Parameters<Parameters<PlayerBalance["update"]>[1]>[0],
    transaction: VerifiedTransaction,
  ): Promise<{ value: Decision; change?: BalanceChange }> {
    const { tx, player, now } = locked;
    const product = await findProduct(tx, transaction.productId);
    if (!product || !isSellable(product, this.config.appEnv)) return { value: { kind: "pending" } };
    // Real stores always give a subscription its chain and expiry. A Pass product whose verified transaction has neither is a
    // staff catalog mistake (a hint pack's store id marked Pass), not a bad receipt: nothing is written, the app keeps it pending.
    // The reverse is the same mistake: a consumable (hint or Miles pack) whose transaction has an expiry or a chain is a
    // subscription id marked consumable, and every renewal would pay again.
    switch (product.kind) {
      case "first_class_pass":
        if (!transaction.originalRef || !transaction.expiresAt) {
          this.logger.error(`catalog product ${product.productId} is first_class_pass but the verified ${transaction.store} transaction has no expiry or original reference`);
          return { value: { kind: "pending" } };
        }
        break;
      case "hint_pack":
      case "miles_pack":
        // Only the expiry marks a subscription: Apple also gives consumables an originalTransactionId (equal to transactionId),
        // so an original reference alone must never block a consumable grant.
        if (transaction.expiresAt) {
          this.logger.error(`catalog product ${product.productId} is ${product.kind} but the verified ${transaction.store} transaction has an expiry`);
          return { value: { kind: "pending" } };
        }
        break;
      default: {
        const unhandled: never = product.kind;
        throw new Error(`No purchase guard for kind ${String(unhandled)}`);
      }
    }

    if (transaction.accountToken !== null) {
      const [account] = await tx.select().from(storeAccounts).where(eq(storeAccounts.playerId, player.id));
      if (!account || normalizeAccountToken(account.commerceToken) !== normalizeAccountToken(transaction.accountToken)) {
        return { value: { kind: "owned_by_other" } };
      }
    }

    const claim = await claimTransaction(tx, { playerId: player.id, product, transaction, now });
    if (claim.kind === "other") return { value: { kind: "owned_by_other" } };
    if (claim.kind === "remembered") throw new PurchaseRollback({ kind: "owned_by_other" });
    // A replay carries no change, so players.version does not move.
    if (claim.kind === "replay") return { value: { kind: "granted", replayed: true, record: claim.row } };

    const ref = `${transaction.store}:${transaction.transactionRef}`;
    switch (product.kind) {
      case "hint_pack": {
        const hints = claim.row.grantedHints;
        if (hints === null) throw new Error("A hint pack grant has no hint count.");
        return {
          value: { kind: "granted", replayed: false, record: claim.row },
          change: { postings: [{ account: "hints", kind: "store_purchase", ref, delta: hints }] },
        };
      }
      case "miles_pack": {
        // Exact Miles, no First Class +50% (that perk lives in scoreRound only); players.miles changes, nothing else does.
        const miles = claim.row.grantedMiles;
        if (miles === null) throw new Error("A Miles pack grant has no Miles amount.");
        return {
          value: { kind: "granted", replayed: false, record: claim.row },
          change: { postings: [{ account: "miles", kind: "store_purchase", ref, delta: miles }] },
        };
      }
      case "first_class_pass": {
        const owned = await claimSubscription(tx, { playerId: player.id, product, transaction, expiresAt: transaction.expiresAt as Date, now });
        if (!owned) throw new PurchaseRollback({ kind: "owned_by_other" });
        const firstClassUntil = await recomputeFirstClassUntil(tx, player.id);
        return { value: { kind: "granted", replayed: false, record: claim.row }, change: { firstClassUntil } };
      }
      default: {
        const unhandled: never = product.kind;
        throw new Error(`No grant for kind ${String(unhandled)}`);
      }
    }
  }

  /**
   * Acknowledge once inline; a transient failure is retried in the background, in process, at `acknowledgeRetryDelaysMs`
   * (bounded, never after shutdown starts). The answer to the app stays 200: the app's own finish also acknowledges (Unity IAP
   * `acknowledgePurchase` / `consumeAsync`), and an unfinished purchase is resent as a replay. P4's durable sweeper replaces this.
   */
  private async acknowledge(transaction: VerifiedTransaction): Promise<void> {
    if (transaction.acknowledged === true) return;
    if (await this.tryAcknowledge(transaction)) return;
    // One retry chain per purchase: a replay while a chain is in flight does not start another.
    const key = `${transaction.store}:${transaction.storeToken ?? transaction.transactionRef}`;
    if (this.acknowledgeChains.has(key) || this.shuttingDown) return;
    this.acknowledgeChains.add(key);
    this.scheduleAcknowledgeRetry(transaction, 0, key);
  }

  /** Delays of the background acknowledge retries (about 10 s, 60 s and 5 min). Tests replace it. */
  acknowledgeRetryDelaysMs: readonly number[] = [10_000, 60_000, 300_000];
  private readonly acknowledgeTimers = new Set<NodeJS.Timeout>();
  /** Keys (`store:token`) with a retry chain in flight. */
  private readonly acknowledgeChains = new Set<string>();
  private shuttingDown = false;

  onModuleDestroy(): void {
    this.shuttingDown = true;
    for (const timer of this.acknowledgeTimers) clearTimeout(timer);
    this.acknowledgeTimers.clear();
    this.acknowledgeChains.clear();
  }

  /** Pending background acknowledge retries (for tests and shutdown). */
  get pendingAcknowledgeRetries(): number {
    return this.acknowledgeTimers.size;
  }

  private scheduleAcknowledgeRetry(transaction: VerifiedTransaction, attempt: number, key: string): void {
    const delay = this.acknowledgeRetryDelaysMs[attempt];
    if (delay === undefined || this.shuttingDown) {
      this.acknowledgeChains.delete(key);
      if (delay === undefined && !this.shuttingDown) this.logger.error(`acknowledge of ${transaction.store} purchase still failing after ${attempt} background retries; the app's finish or P4 must cover it`);
      return;
    }
    const timer = setTimeout(() => {
      this.acknowledgeTimers.delete(timer);
      if (this.shuttingDown) {
        this.acknowledgeChains.delete(key);
        return;
      }
      void this.tryAcknowledge(transaction).then((ok) => {
        if (ok) this.acknowledgeChains.delete(key);
        else this.scheduleAcknowledgeRetry(transaction, attempt + 1, key);
      });
    }, delay);
    timer.unref();
    this.acknowledgeTimers.add(timer);
  }

  private async tryAcknowledge(transaction: VerifiedTransaction): Promise<boolean> {
    try {
      const result = await this.verifier.acknowledge(transaction, AbortSignal.timeout(ACKNOWLEDGE_TIMEOUT_MS));
      if (result.kind === "ok") return true;
      this.logger.warn(`acknowledge of ${transaction.store} purchase did not complete (transient)`);
    } catch (error) {
      this.logger.warn(`acknowledge of ${transaction.store} purchase failed (${error instanceof Error ? error.constructor.name : typeof error}); adapters must return results`);
    }
    return false;
  }
}
