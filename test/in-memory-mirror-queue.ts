import { randomUUID } from "node:crypto";
import { LEASE_MS, mirrorDueAt } from "../src/ugs/mirror-policy.js";
import type { Claimed, MirrorQueue, ProcessResult } from "../src/ugs/mirror-queue.js";

/**
 * Test double for the MirrorQueue seam: the same claim / process / release / fail / drop contract as the Postgres
 * adapters, over a Map, so the worker loop can be unit-tested without a database. `outcome` decides what the
 * "UGS call" answers for a row (default: success, which removes it like a finished write). `minIntervalSec` is the C3
 * minimum interval. A write queue models ugs_links and ugs_mirror_pace too: every key is linked to the UGS player
 * `ugs-<key>` until `relink()` changes it; a successful write records the pace row (only while the key is still linked
 * to the UGS player the write went to); `enqueue()` computes `due_at` from the pace row of the CURRENT link like
 * enqueueMirror; a row changed while it was written is reset like ProgressWriteQueue.resetChanged.
 */
export type MemoryRow = {
  key: string;
  dueAt: Date;
  claimId: string | null;
  attempts: number;
  generation: number;
  lastError: string | null;
  /** An urgent enqueue landed while the row was claimed (ugs_mirror_outbox.urgent). */
  urgent: boolean;
};

export class InMemoryMirrorQueue implements MirrorQueue {
  readonly rows = new Map<string, MemoryRow>();
  /** Keys passed to process(), in call order. */
  readonly processed: string[] = [];
  /** ugs_mirror_pace: for each key, the UGS player last written and when. Only the write queue records it. */
  readonly pace = new Map<string, { ugsPlayerId: string; at: Date }>();
  /** The current ugs_links.ugs_player_id per key; absent means the default `ugs-<key>`. */
  private readonly links = new Map<string, string>();
  /** Answer for a row; return "done" to finish it. */
  outcome: (claimed: Claimed) => ProcessResult | Promise<ProcessResult> = () => "done";
  private generation = 0;

  constructor(
    readonly op: "write" | "delete",
    private readonly minIntervalSec = 0,
  ) {}

  /** The UGS player this key is linked to now. */
  linkOf(key: string): string {
    return this.links.get(key) ?? `ugs-${key}`;
  }

  /** The key is linked to a different UGS player from now on (a re-link or a link move). */
  relink(key: string, ugsPlayerId = `ugs-${key}-${randomUUID()}`): void {
    this.links.set(key, ugsPlayerId);
  }

  /** Pretend `key` was last written at `at` to its current link. */
  setPace(key: string, at: Date): void {
    this.pace.set(key, { ugsPlayerId: this.linkOf(key), at });
  }

  /** ugs_mirror_pace.last_mirrored_at for the CURRENT link, or null (no row, or a row for another UGS player). */
  lastMirrored(key: string): Date | null {
    const row = this.pace.get(key);
    return row && row.ugsPlayerId === this.linkOf(key) ? row.at : null;
  }

  /**
   * Like enqueueMirror with the interval. A new row is due at mirrorDueAt(now, pace of the current link, interval). On an
   * existing row: a waiting one (not claimed, no attempts) takes the earlier of its due time and that, a claimed one
   * keeps its lease and remembers an urgent request, a backing-off one keeps its due time; the generation always moves.
   */
  enqueue(key: string, now: Date, dueNow = false): void {
    const existing = this.rows.get(key);
    const due = mirrorDueAt(now, this.lastMirrored(key), this.minIntervalSec, dueNow);
    this.add(key, due);
    if (!existing) return;
    if (existing.claimId === null && existing.attempts === 0 && due < existing.dueAt) existing.dueAt = due;
    if (existing.claimId !== null && dueNow) existing.urgent = true;
  }

  /** Like enqueueMirror: a new row is inserted; an existing key only gets a newer generation (due_at, claim and attempts stay). */
  add(key: string, dueAt: Date, attempts = 0): void {
    this.generation += 1;
    const existing = this.rows.get(key);
    if (existing) {
      existing.generation = this.generation;
      return;
    }
    this.rows.set(key, { key, dueAt, claimId: null, attempts, generation: this.generation, lastError: null, urgent: false });
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
    const writtenTo = this.linkOf(claimed.key); // the UGS player the call goes to
    const result = await this.outcome(claimed);
    if (result === "done") {
      // Recorded only while the key still has that very link (the player may have re-linked during the write).
      if (this.op === "write" && this.linkOf(claimed.key) === writtenTo) this.pace.set(claimed.key, { ugsPlayerId: writtenTo, at: now });
      const row = this.mine(claimed);
      // A deletion queue has no generations (claimed.generation is 0): it finishes under its own claim alone.
      if (row && (this.op === "delete" || row.generation === claimed.generation)) this.rows.delete(claimed.key);
      else if (row) {
        // Changed while we were writing: due again like a new enqueue (ProgressWriteQueue.resetChanged): now when an
        // urgent enqueue landed meanwhile or there is no pace row for the current link, else one interval after the write.
        row.dueAt = mirrorDueAt(now, this.lastMirrored(claimed.key), this.minIntervalSec, row.urgent);
        row.attempts = 0;
        row.lastError = null;
        row.claimId = null;
        row.urgent = false;
      }
    }
    return result;
  }

  async release(claimed: Claimed, dueAt: Date): Promise<void> {
    const row = this.mine(claimed);
    if (row) {
      row.dueAt = dueAt;
      row.claimId = null;
      row.urgent = false;
    }
  }

  async fail(claimed: Claimed, dueAt: Date, label: string): Promise<void> {
    const row = this.mine(claimed);
    if (row) {
      row.dueAt = dueAt;
      row.attempts += 1;
      row.lastError = label;
      row.claimId = null;
      row.urgent = false;
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
