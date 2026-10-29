import { randomUUID } from "node:crypto";
import { LEASE_MS } from "../src/ugs/mirror-policy.js";
import type { Claimed, MirrorQueue, ProcessResult } from "../src/ugs/mirror-queue.js";

/**
 * Test double for the MirrorQueue seam: the same claim / process / release / fail / drop contract as the Postgres
 * adapters, over a Map, so the worker loop can be unit-tested without a database. `outcome` decides what the
 * "UGS call" answers for a row (default: success, which removes it like a finished write).
 */
export type MemoryRow = { key: string; dueAt: Date; claimId: string | null; attempts: number; generation: number; lastError: string | null };

export class InMemoryMirrorQueue implements MirrorQueue {
  readonly rows = new Map<string, MemoryRow>();
  /** Keys passed to process(), in call order. */
  readonly processed: string[] = [];
  /** Answer for a row; return "done" to finish it. */
  outcome: (claimed: Claimed) => ProcessResult | Promise<ProcessResult> = () => "done";
  private generation = 0;

  constructor(readonly op: "write" | "delete") {}

  /** Like enqueueMirror: a new row is inserted; an existing key only gets a newer generation (due_at, claim and attempts stay). */
  add(key: string, dueAt: Date, attempts = 0): void {
    this.generation += 1;
    const existing = this.rows.get(key);
    if (existing) {
      existing.generation = this.generation;
      return;
    }
    this.rows.set(key, { key, dueAt, claimId: null, attempts, generation: this.generation, lastError: null });
  }

  async claim(limit: number, now: Date): Promise<Claimed[]> {
    const due = [...this.rows.values()]
      .filter((row) => row.dueAt <= now)
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .slice(0, limit);
    return due.map((row) => {
      row.dueAt = new Date(now.getTime() + LEASE_MS);
      row.claimId = randomUUID();
      return { key: row.key, generation: this.op === "delete" ? 0 : row.generation, claimId: row.claimId, attempts: row.attempts };
    });
  }

  async process(claimed: Claimed, now: Date, _signal: AbortSignal): Promise<ProcessResult> {
    this.processed.push(claimed.key);
    const result = await this.outcome(claimed);
    if (result === "done") {
      const row = this.mine(claimed);
      // A deletion queue has no generations (claimed.generation is 0): it finishes under its own claim alone.
      if (row && (this.op === "delete" || row.generation === claimed.generation)) this.rows.delete(claimed.key);
      else if (row) {
        // Changed while we were writing: due again now, like ProgressWriteQueue.process.
        row.dueAt = now;
        row.attempts = 0;
        row.lastError = null;
        row.claimId = null;
      }
    }
    return result;
  }

  async release(claimed: Claimed, dueAt: Date): Promise<void> {
    const row = this.mine(claimed);
    if (row) {
      row.dueAt = dueAt;
      row.claimId = null;
    }
  }

  async fail(claimed: Claimed, dueAt: Date, label: string): Promise<void> {
    const row = this.mine(claimed);
    if (row) {
      row.dueAt = dueAt;
      row.attempts += 1;
      row.lastError = label;
      row.claimId = null;
    }
  }

  async drop(claimed: Claimed): Promise<void> {
    if (this.mine(claimed)) this.rows.delete(claimed.key);
  }

  async backlog(now: Date): Promise<{ count: number; oldest: Date | null }> {
    const due = [...this.rows.values()].filter((row) => row.dueAt <= now);
    const oldest = due.reduce<Date | null>((min, row) => (min && min <= row.dueAt ? min : row.dueAt), null);
    return { count: due.length, oldest };
  }

  /** The row, only if it is still under this claim (the delete-only-if-own-claim rule). */
  private mine(claimed: Claimed): MemoryRow | undefined {
    const row = this.rows.get(claimed.key);
    return row && row.claimId === claimed.claimId ? row : undefined;
  }
}
