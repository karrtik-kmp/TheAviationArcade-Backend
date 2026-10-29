import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/config.module.js";
import {
  BACKOFF_CAP_MS,
  CREDENTIALS_PAUSE_MS,
  DEAD_DELETION_BACKOFF_MS,
  LEASE_MS,
  MAX_REJECTED_ATTEMPTS,
  REJECTED_BACKOFF_MS,
  backoffMs,
} from "../src/ugs/mirror-policy.js";
import type { Claimed } from "../src/ugs/mirror-queue.js";
import { CopyDeletionQueue, ProgressWriteQueue } from "../src/ugs/mirror-queue.js";
import { MirrorWorker, defaultMirrorQueues } from "../src/ugs/mirror-worker.js";
import type { UgsWorkerOptions } from "../src/ugs/ugs.tokens.js";
import { InMemoryMirrorQueue } from "./in-memory-mirror-queue.js";

// Unit tests of the mirror worker loop over the in-memory MirrorQueue: no Postgres, no network. The same behaviours
// run against Postgres and a stubbed UGS in ugs.e2e.test.ts; here the queue contract and the worker policy are
// pinned separately.

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const at = (ms: number) => new Date(ms);
const OPTIONS: UgsWorkerOptions = { autoStart: false, intervalMs: 1000, clock: () => T0 };

function build(perMin = 600) {
  const deletions = new InMemoryMirrorQueue("delete");
  const writes = new InMemoryMirrorQueue("write");
  const config = { ugs: { mirrorMaxPerMin: perMin } } as unknown as AppConfig;
  // The client is never called (the queues own the UGS call); only its presence switches the worker on.
  const worker = new MirrorWorker(null as never, {} as never, OPTIONS, config, [deletions, writes]);
  return { worker, deletions, writes };
}

function events(spy: { mock: { calls: unknown[][] } }, event: string): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c) => c[0])
    .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null && (m as { event?: unknown }).event === event);
}

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("InMemoryMirrorQueue honours the MirrorQueue claim contract", () => {
  it("claim leases due rows (due_at = now + LEASE_MS, fresh claim id) and skips rows that are not due or already leased", async () => {
    const q = new InMemoryMirrorQueue("write");
    q.add("a", at(T0 - 10));
    q.add("b", at(T0 - 5));
    q.add("later", at(T0 + 1));
    const first = await q.claim(5, at(T0));
    expect(first.map((c) => c.key)).toEqual(["a", "b"]);
    expect(new Set(first.map((c) => c.claimId)).size).toBe(2);
    expect(q.rows.get("a")?.dueAt.getTime()).toBe(T0 + LEASE_MS);
    expect(await q.claim(5, at(T0))).toEqual([]);
  });

  it("claim respects the limit and takes the oldest first", async () => {
    const q = new InMemoryMirrorQueue("write");
    q.add("new", at(T0 - 1));
    q.add("old", at(T0 - 100));
    expect((await q.claim(1, at(T0))).map((c) => c.key)).toEqual(["old"]);
  });

  it("release and fail change a row only while the claim is still ours", async () => {
    const q = new InMemoryMirrorQueue("write");
    q.add("a", at(T0));
    const [mine] = await q.claim(1, at(T0));
    const stale: Claimed = { ...mine!, claimId: "someone-else" };
    await q.release(stale, at(T0 + 5));
    await q.fail(stale, at(T0 + 5), "x");
    await q.drop(stale);
    expect(q.rows.get("a")).toMatchObject({ claimId: mine!.claimId, attempts: 0, lastError: null });
    await q.fail(mine!, at(T0 + 7), "http 500");
    expect(q.rows.get("a")).toMatchObject({ claimId: null, attempts: 1, lastError: "http 500" });
    expect(q.rows.get("a")?.dueAt.getTime()).toBe(T0 + 7);
  });

  it("a finished row is deleted only under its own claim and generation", async () => {
    const q = new InMemoryMirrorQueue("write");
    q.add("a", at(T0));
    const [claimed] = await q.claim(1, at(T0));
    const signal = new AbortController().signal;
    await q.process({ ...claimed!, claimId: "someone-else" }, at(T0), signal);
    expect(q.rows.get("a")).toMatchObject({ claimId: claimed!.claimId, attempts: 0, generation: claimed!.generation });
    expect(q.rows.get("a")!.dueAt.getTime()).toBe(T0 + LEASE_MS); // untouched: still leased to us
    await q.process({ ...claimed!, generation: claimed!.generation + 1 }, at(T0), signal);
    // Our claim, but the generation differs: kept, due now, attempts reset, claim cleared.
    expect(q.rows.get("a")).toMatchObject({ claimId: null, attempts: 0, lastError: null });
    expect(q.rows.get("a")!.dueAt.getTime()).toBe(T0);
    const [again] = await q.claim(1, at(T0));
    await q.process(again!, at(T0), signal);
    expect(q.rows.has("a")).toBe(false);
  });

  it("add() on an existing key only bumps the generation (due_at, claim and attempts stay), like the ON CONFLICT", async () => {
    const q = new InMemoryMirrorQueue("write");
    q.add("a", at(T0), 2);
    const [claimed] = await q.claim(1, at(T0));
    q.add("a", at(T0 - 1_000));
    const row = q.rows.get("a")!;
    expect(row).toMatchObject({ claimId: claimed!.claimId, attempts: 2 });
    expect(row.dueAt.getTime()).toBe(T0 + LEASE_MS);
    expect(row.generation).toBeGreaterThan(claimed!.generation);
  });

  it("the deletion double reports generation 0, as CopyDeletionQueue does", async () => {
    const q = new InMemoryMirrorQueue("delete");
    q.add("ugs-1", at(T0));
    expect((await q.claim(1, at(T0)))[0]).toMatchObject({ generation: 0 });
  });
});

describe("production queue order", () => {
  it("defaultMirrorQueues puts deletions before writes", () => {
    const queues = defaultMirrorQueues(null as never, {} as never);
    expect(queues.map((q) => q.op)).toEqual(["delete", "write"]);
    expect(queues[0]).toBeInstanceOf(CopyDeletionQueue);
    expect(queues[1]).toBeInstanceOf(ProgressWriteQueue);
  });
});

describe("MirrorWorker loop over MirrorQueue", () => {
  it("does nothing without queues (UGS not configured)", async () => {
    const worker = new MirrorWorker(null as never, null, OPTIONS, { ugs: undefined } as unknown as AppConfig);
    expect(await worker.tick(T0)).toMatchObject({ written: 0, deleted: 0, backlog: 0 });
  });

  it("drains deletions before writes: with a budget of 1 only the deletion is taken", async () => {
    const { worker, deletions, writes } = build(1);
    deletions.add("ugs-old", at(T0 - 1));
    writes.add("p1", at(T0 - 100)); // older than the deletion, still second
    const summary = await worker.tick(T0);
    expect(summary).toMatchObject({ deleted: 1, written: 0, backlog: 2 });
    expect(deletions.processed).toEqual(["ugs-old"]);
    expect(writes.processed).toEqual([]);
    expect(writes.rows.get("p1")?.claimId).toBeNull(); // never claimed
  });

  it("processes in priority order and counts written / deleted", async () => {
    const { worker, deletions, writes } = build();
    deletions.add("d1", at(T0 - 1));
    writes.add("w1", at(T0 - 1));
    writes.add("w2", at(T0 - 1));
    expect(await worker.tick(T0)).toMatchObject({ deleted: 1, written: 2, retried: 0, rejected: 0 });
    expect(deletions.rows.size + writes.rows.size).toBe(0);
  });

  it("logs backlog and the oldest lag on a tick with due rows, summed over both queues", async () => {
    const { worker, deletions, writes } = build();
    deletions.add("d1", at(T0 - 5_000));
    writes.add("w1", at(T0 - 90_000));
    await worker.tick(T0);
    const [batch] = events(log, "ugs_mirror_batch");
    expect(batch).toMatchObject({ backlog: 2, lagMs: 90_000, written: 1, deleted: 1, paused: false });
  });

  it("logs nothing on an empty tick", async () => {
    const { worker } = build();
    await worker.tick(T0);
    expect(log).not.toHaveBeenCalled();
  });

  it("429 pauses the worker for Retry-After and returns the unprocessed claims without counting an attempt", async () => {
    const { worker, writes } = build();
    for (const k of ["a", "b", "c"]) writes.add(k, at(T0 - 1));
    writes.outcome = () => ({ kind: "rate_limited", retryAfterMs: 30_000 });
    const summary = await worker.tick(T0);
    expect(summary).toMatchObject({ rateLimited: true, written: 0 });
    expect(writes.processed).toHaveLength(1); // halts after the first answer
    for (const row of writes.rows.values()) {
      expect(row).toMatchObject({ attempts: 0, claimId: null });
      expect(row.dueAt.getTime()).toBe(T0 + 30_000);
    }
    writes.outcome = () => "done";
    expect(await worker.tick(T0 + 10_000)).toMatchObject({ written: 0 }); // still paused
    expect(events(log, "ugs_mirror_batch").at(-1)).toMatchObject({ paused: true });
    expect(await worker.tick(T0 + 30_000)).toMatchObject({ written: 3 });
  });

  it("401/403 pause for 15 minutes with exactly one error log; rows are kept without attempts", async () => {
    const { worker, writes, deletions } = build();
    deletions.add("d", at(T0 - 1));
    writes.add("w", at(T0 - 1));
    deletions.outcome = () => ({ kind: "auth_failed", status: 401 });
    const summary = await worker.tick(T0);
    expect(summary.credentialsRejected).toBe(true);
    expect(events(error, "ugs_mirror_credentials_rejected")).toHaveLength(1);
    expect(events(error, "ugs_mirror_credentials_rejected")[0]).toMatchObject({ status: 401, pausedMs: CREDENTIALS_PAUSE_MS });
    expect(writes.processed).toEqual([]); // halted: the write was released, not tried
    for (const row of [deletions.rows.get("d")!, writes.rows.get("w")!]) {
      expect(row.attempts).toBe(0);
      expect(row.dueAt.getTime()).toBe(T0 + CREDENTIALS_PAUSE_MS);
    }
    await worker.tick(T0 + 60_000);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("5xx and network errors back off per row (5 s doubling, capped) and count an attempt", async () => {
    const { worker, writes } = build();
    writes.add("fresh", at(T0 - 1));
    writes.add("tired", at(T0 - 1), 20);
    writes.outcome = () => ({ kind: "transient", status: 503 });
    const summary = await worker.tick(T0);
    expect(summary.retried).toBe(2);
    expect(writes.rows.get("fresh")).toMatchObject({ attempts: 1, lastError: "http 503", claimId: null });
    expect(writes.rows.get("fresh")!.dueAt.getTime()).toBe(T0 + backoffMs(1));
    expect(writes.rows.get("tired")!.dueAt.getTime()).toBe(T0 + BACKOFF_CAP_MS);
  });

  it("a write rejected (other 4xx) backs off an hour, logs once, and is dropped on the 3rd rejection", async () => {
    const { worker, writes } = build();
    writes.add("w", at(T0 - 1));
    writes.outcome = () => ({ kind: "rejected", status: 400 });
    let now = T0;
    for (let i = 1; i < MAX_REJECTED_ATTEMPTS; i += 1) {
      expect((await worker.tick(now)).rejected).toBe(1);
      expect(writes.rows.get("w")).toMatchObject({ attempts: i });
      expect(writes.rows.get("w")!.dueAt.getTime()).toBe(now + REJECTED_BACKOFF_MS);
      now += REJECTED_BACKOFF_MS;
    }
    expect(events(warn, "ugs_mirror_rejected")).toHaveLength(1); // once per row
    await worker.tick(now);
    expect(writes.rows.has("w")).toBe(false);
    expect(events(warn, "ugs_mirror_dropped")).toEqual([{ event: "ugs_mirror_dropped", status: 400, op: "write", attempts: MAX_REJECTED_ATTEMPTS }]);
  });

  it("a deletion rejected 3 times is kept and retried daily", async () => {
    const { worker, deletions } = build();
    deletions.add("d", at(T0 - 1), MAX_REJECTED_ATTEMPTS - 1);
    deletions.outcome = () => ({ kind: "rejected", status: 404 });
    await worker.tick(T0);
    expect(deletions.rows.get("d")).toMatchObject({ attempts: MAX_REJECTED_ATTEMPTS, claimId: null });
    expect(deletions.rows.get("d")!.dueAt.getTime()).toBe(T0 + DEAD_DELETION_BACKOFF_MS);
  });

  it("the once-logging key includes the op, so a player id and a UGS id can never collide", async () => {
    const { worker, deletions, writes } = build();
    deletions.add("same-id", at(T0 - 1));
    writes.add("same-id", at(T0 - 1));
    deletions.outcome = writes.outcome = () => ({ kind: "rejected", status: 400 });
    await worker.tick(T0);
    expect(events(warn, "ugs_mirror_rejected").map((e) => e.op).sort()).toEqual(["delete", "write"]);
    // Success of the write clears only the write's flag: a later rejection of the write logs again, the deletion's does not.
    writes.outcome = () => "done";
    await worker.tick(T0 + REJECTED_BACKOFF_MS);
    writes.add("same-id", at(T0));
    writes.outcome = () => ({ kind: "rejected", status: 400 });
    await worker.tick(T0 + REJECTED_BACKOFF_MS + 1);
    expect(events(warn, "ugs_mirror_rejected").map((e) => e.op).sort()).toEqual(["delete", "write", "write"]);
  });

  it("paces with the token bucket: rows beyond the bucket are never claimed, so they stay due", async () => {
    const { worker, writes } = build(2);
    for (const k of ["a", "b", "c"]) writes.add(k, at(T0 - 1));
    expect((await worker.tick(T0)).written).toBe(2);
    expect(writes.processed).toHaveLength(2);
    expect(writes.rows.size).toBe(1);
    expect(writes.rows.values().next().value).toMatchObject({ attempts: 0, claimId: null });
  });

  it("shutdown stops the loop: a tick after onModuleDestroy releases what it claimed without calling out", async () => {
    const { worker, writes } = build();
    writes.add("w", at(T0 - 1));
    await worker.onModuleDestroy();
    const summary = await worker.tick(T0);
    expect(writes.processed).toEqual([]);
    expect(summary.written).toBe(0);
    expect(writes.rows.get("w")).toMatchObject({ claimId: null, attempts: 0 });
    expect(writes.rows.get("w")!.dueAt.getTime()).toBe(T0);
  });

  it("a change enqueued while a write is in flight leaves the row due again with the newer generation, written next tick", async () => {
    const { worker, writes } = build();
    writes.add("w", at(T0 - 1));
    let firstGeneration = 0;
    let first = true;
    writes.outcome = async (claimed) => {
      if (first) {
        first = false;
        firstGeneration = claimed.generation;
        writes.add("w", at(T0)); // a real re-enqueue while process() is awaiting
      }
      return "done" as const;
    };
    expect(await worker.tick(T0)).toMatchObject({ written: 1 });
    const row = writes.rows.get("w")!;
    expect(row.generation).toBeGreaterThan(firstGeneration);
    expect(row).toMatchObject({ claimId: null, attempts: 0, lastError: null });
    expect(row.dueAt.getTime()).toBe(T0);
    expect(await worker.tick(T0 + 1)).toMatchObject({ written: 1 });
    expect(writes.rows.has("w")).toBe(false);
    expect(writes.processed).toEqual(["w", "w"]);
  });

  it("onModuleDestroy aborts the signal handed to an in-flight process()", async () => {
    const { worker, writes } = build();
    writes.add("w", at(T0 - 1));
    let seen: AbortSignal | undefined;
    writes.process = async (claimed, _now, signal) => {
      seen = signal;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      return { kind: "transient", status: "network" };
    };
    const running = worker.tick(T0);
    await vi.waitFor(() => expect(seen).toBeDefined());
    await worker.onModuleDestroy();
    expect(seen!.aborted).toBe(true);
    await running;
  });
});
