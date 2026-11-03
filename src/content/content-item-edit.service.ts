import { Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { ApiError } from "../common/errors.js";
import { DatabaseService } from "../database/database.module.js";
import type { Tx } from "../database/database.module.js";
import type { AdminAuditAction, ContentStatus } from "../db/enums.js";
import { adminAudit, contentItems } from "../db/schema.js";
import type { ContentItemRow } from "../db/schema.js";
import { militaryCardKey } from "../rules/clipper-cards.js";
import { isRank } from "../rules/ranks.js";
import type { Rank } from "../rules/ranks.js";
import type { ContentModuleMapping } from "./content-module.js";
import { lockContentModule, readContentStamp } from "./content-lock.js";
import { canonicalJson, diffItem, planImport } from "./import-plan.js";
import type { ExistingItem, FieldDiff } from "./import-plan.js";
import type { ItemView } from "./content.service.js";

const MILITARY = "aircraft-identifier-military";

/** The Card key of the answer as stored (null when there is none, as the lazy freeze treats it). */
function militaryKeyOfStored(data: unknown): string | null {
  const answer = (data as { answer?: unknown } | null)?.answer;
  return (typeof answer === "string" ? militaryCardKey(answer) : "") || null;
}

export type ItemEdit = { rank?: Rank | undefined; data?: unknown };

export type ItemChange = { changed: boolean; item: ItemView; diff: FieldDiff[] };

function view(row: ContentItemRow): ItemView {
  return {
    id: row.id,
    rank: row.rank,
    status: row.status,
    source: row.source,
    version: row.version,
    data: row.data,
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Outcome = { ok: true; value: ItemChange } | { ok: false; error: ApiError };

/**
 * Staff edit-in-place of one content item: edit (rank / payload), retire, restore. Each is optimistic (the caller's
 * `version` must equal the stored one) and runs in one transaction under the module lock the import apply uses.
 * A change bumps the version, records source `admin` and the actor, and appends one admin_audit row with the
 * field-level diff. A Clipper Card key is frozen at first import and an edit never moves it; the one exception is a Military item
 * with no stored key (a row older than migration 0009), which gets the key of its PRE-edit answer in the same UPDATE. An unchanged
 * request writes nothing: no bump, no audit row. A retired item stays retired when edited.
 */
@Injectable()
export class ContentItemEditService {
  constructor(private readonly database: DatabaseService) {}

  async edit(mapping: ContentModuleMapping, id: string, expectedVersion: number, change: ItemEdit, principal: string): Promise<ItemChange> {
    // The payload rules are the mapping's own (the sheet parser calls the same function), checked before any lock.
    let checked: { data: Record<string, unknown> } | undefined;
    if (change.data !== undefined) {
      const result = mapping.validatePayload(change.data);
      if (result.problems.length > 0) {
        throw new ApiError(422, "import_invalid", `The item is not valid: ${result.problems.join(" ")} Nothing was changed.`);
      }
      checked = { data: result.data };
    }
    return this.run(mapping.module, id, expectedVersion, principal, async (tx, stored, existing, now) => {
      const rank = change.rank ?? (isRank(stored.rank) ? stored.rank : undefined);
      if (!rank) throw new ApiError(422, "import_invalid", "The stored rank is not valid; send a rank. Nothing was changed.");
      const data = checked?.data ?? (stored.data as Record<string, unknown>);
      if (rank === stored.rank && canonicalJson(data) === canonicalJson(stored.data)) return { kind: "unchanged" };
      // The natural-key rule lives in the planner (non-blank, unique across the module, retired items included):
      // plan this one row as an admin-export update against the locked rows and take any error it finds.
      const plan = planImport(
        [{ row: 1, id, naturalKey: mapping.naturalKey(data), version: stored.version, rank, data }],
        existing,
        { kind: "admin_export", mapping },
      );
      const problem = plan.issues.find((issue) => issue.level !== "warning");
      if (problem) throw new ApiError(422, "import_invalid", `${problem.message} Nothing was changed.`);
      const diff = diffItem(stored, { rank, data });
      const [row] = await tx
        .update(contentItems)
        .set({
          rank,
          data,
          // A Military row older than migration 0009 has no frozen key; freeze it from the STORED answer so this edit
          // cannot move it (the lazy freeze in rounds / the Card catalog would otherwise read the new answer).
          ...(mapping.module === MILITARY && stored.cardKey === null ? { cardKey: militaryKeyOfStored(stored.data) } : {}),
          version: sql`${contentItems.version} + 1`,
          source: "admin",
          updatedAt: now,
          updatedBy: principal,
        })
        .where(and(eq(contentItems.module, mapping.module), eq(contentItems.id, id), eq(contentItems.version, stored.version)))
        .returning();
      return { kind: "changed", row, diff, action: "content_edit" };
    });
  }

  /** retire → `retired`, restore → `approved`. Already in that state is `changed: false`. */
  async setStatus(module: string, id: string, expectedVersion: number, status: ContentStatus, principal: string): Promise<ItemChange> {
    return this.run(module, id, expectedVersion, principal, async (tx, stored, _existing, now) => {
      if (stored.status === status) return { kind: "unchanged" };
      const [row] = await tx
        .update(contentItems)
        .set({ status, version: sql`${contentItems.version} + 1`, source: "admin", updatedAt: now, updatedBy: principal })
        .where(and(eq(contentItems.module, module), eq(contentItems.id, id), eq(contentItems.version, stored.version)))
        .returning();
      return {
        kind: "changed",
        row,
        diff: [{ field: "status", from: stored.status, to: status }],
        action: status === "retired" ? "content_retire" : "content_restore",
      };
    });
  }

  private async run(
    module: string,
    id: string,
    expectedVersion: number,
    principal: string,
    step: (
      tx: Tx,
      stored: ContentItemRow,
      existing: Map<string, ExistingItem>,
      now: SQL,
    ) => Promise<{ kind: "unchanged" } | { kind: "changed"; row: ContentItemRow | undefined; diff: FieldDiff[]; action: AdminAuditAction }>,
  ): Promise<ItemChange> {
    // Expected refusals are returned, not thrown, so the connection goes back to the pool instead of being destroyed.
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome> => {
      try {
        await lockContentModule(tx, module);
        const now = await readContentStamp(tx); // one database instant after the lock; see readContentStamp
        const rows = await tx.select().from(contentItems).where(eq(contentItems.module, module));
        const stored = rows.find((r) => r.id === id);
        if (!stored) return { ok: false, error: new ApiError(404, "not_found", "No such item.") };
        if (stored.version !== expectedVersion) {
          return {
            ok: false,
            error: new ApiError(409, "version_conflict", `The item is at version ${stored.version}, not ${expectedVersion}. Reload it and apply the change again. Nothing was changed.`),
          };
        }
        const existing = new Map<string, ExistingItem>();
        for (const r of rows) if (isRank(r.rank)) existing.set(r.id, { id: r.id, rank: r.rank, status: r.status, version: r.version, data: r.data });
        const result = await step(tx, stored, existing, now);
        if (result.kind === "unchanged") return { ok: true, value: { changed: false, item: view(stored), diff: [] } };
        if (!result.row) throw new Error("Item update was not stored."); // the advisory lock makes this unreachable
        await tx.insert(adminAudit).values({
          actor: principal,
          action: result.action,
          target: module,
          detail: { id, fromVersion: stored.version, version: result.row.version, diff: result.diff },
          createdAt: now,
        });
        return { ok: true, value: { changed: true, item: view(result.row), diff: result.diff } };
      } catch (error) {
        if (error instanceof ApiError) return { ok: false, error }; // every ApiError is raised before the first write
        throw error;
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}
