import { Injectable } from "@nestjs/common";
import { desc } from "drizzle-orm";
import { DatabaseService } from "../database/database.module.js";
import type { AdminAuditAction } from "../db/enums.js";
import { adminAudit } from "../db/schema.js";

/** Docs/plans/website-content.md W4: the staff audit desk. The newest rows only; there is no paging and no filter. */
export const AUDIT_READ_LIMIT = 50;

export type AuditEvent = {
  id: string;
  entity: string;
  action: AdminAuditAction;
  actor: string;
  detail: unknown;
  createdAt: string;
};

/** `aud-<n>` in the repo's style (`med-`, `ed-`): the opaque row id, an identity column that only ever grows. */
export const formatAuditId = (id: number): string => `aud-${id}`;

/**
 * The two projections, each pinned to its action. A `media_import` row keeps the photographer's free-text `rightsEvidence` (it may
 * hold contact details): the desk shows only `rightsEvidenceLength`. A `media_edit` row keeps the owning photographer's `note`, which
 * lives only in the audit row: the desk shows only `noteLength`. Both are lengths in code points. Every other detail, and every
 * other key of these two, passes through unchanged.
 */
const PROJECTIONS: Partial<Record<AdminAuditAction, { key: string; lengthKey: string }>> = {
  media_import: { key: "rightsEvidence", lengthKey: "rightsEvidenceLength" },
  media_edit: { key: "note", lengthKey: "noteLength" },
};

export function projectDetail(action: AdminAuditAction, detail: unknown): unknown {
  const projection = PROJECTIONS[action];
  if (!projection || detail === null || typeof detail !== "object" || Array.isArray(detail)) return detail;
  const { [projection.key]: text, ...rest } = detail as Record<string, unknown>;
  if (typeof text !== "string") return detail;
  return { ...rest, [projection.lengthKey]: [...text].length };
}

@Injectable()
export class AuditReadService {
  constructor(private readonly database: DatabaseService) {}

  async latest(): Promise<{ events: AuditEvent[] }> {
    const rows = await this.database.db.select().from(adminAudit).orderBy(desc(adminAudit.id)).limit(AUDIT_READ_LIMIT);
    return {
      events: rows.map((row) => ({
        id: formatAuditId(row.id),
        entity: row.target,
        action: row.action,
        actor: row.actor,
        detail: projectDetail(row.action, row.detail),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
}
