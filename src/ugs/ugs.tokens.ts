import type { JWTVerifyGetKey } from "jose";

/** Injection tokens for the UGS mirror. Tests override these; nothing here is configured by a client. */
export const UGS_FETCH = Symbol("UGS_FETCH");
export const UGS_KEYS = Symbol("UGS_KEYS");
export const UGS_CLIENT = Symbol("UGS_CLIENT");
export const UGS_WORKER_OPTIONS = Symbol("UGS_WORKER_OPTIONS");
/** Optional override of the mirror worker queues (unit tests); production builds the Postgres adapters. */
export const UGS_MIRROR_QUEUES = Symbol("UGS_MIRROR_QUEUES");
/** The shared UgsBudget for Cloud Save writes and deletions (null when UGS is off). Tests may override it. */
export const UGS_BUDGET = Symbol("UGS_BUDGET");
/** The shared UgsBudget for Player Auth admin calls (link proofs), its own row. Tests replace or reset it. */
export const UGS_PROOF_BUDGET = Symbol("UGS_PROOF_BUDGET");

export type UgsKeys = JWTVerifyGetKey;

export type UgsWorkerOptions = {
  /** Run the interval loop. Tests turn it off and call tick() themselves. */
  autoStart: boolean;
  intervalMs: number;
  /** Milliseconds since the epoch. */
  clock: () => number;
  /**
   * Whose clock the shared Postgres budgets use. Default "database" (the database server's clock, one for every
   * instance). Tests that drive ticks with explicit clocks set "caller".
   */
  budgetTime?: "database" | "caller";
};

export const DEFAULT_WORKER_OPTIONS: UgsWorkerOptions = { autoStart: true, intervalMs: 2000, clock: () => Date.now() };
