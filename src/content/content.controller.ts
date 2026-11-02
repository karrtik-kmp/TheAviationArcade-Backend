import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { Principal } from "../auth/firebase-auth.guard.js";
import { StaffOnly } from "../auth/staff.js";
import { ApiError } from "../common/errors.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { DEAL_POLICY } from "../rules/dealer.js";
import { MODULE_IDS } from "../rules/modules.js";
import type { ModuleId } from "../rules/modules.js";
import { SkipClientVersion } from "../platform/client-version.js";
import type { ContentModuleMapping } from "./content-module.js";
import { contentMappingFor } from "./content-modules.js";
import { ContentService } from "./content.service.js";
import { XLSX_MIME } from "./xlsx.js";

// dryRun and confirm are the only query parameters; anything else, or a bad value, is a 400.
// confirm is the planHash (sha256 hex) from a dry run of the same file.
const importQuery = z.strictObject({
  dryRun: z.enum(["true", "false"]).optional(),
  confirm: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
type ImportQuery = z.infer<typeof importQuery>;

export const MAX_COVERAGE_IDS = 2000;
/** Ids are short (`mil-a31`); the cap keeps 2000 of them inside the route's JSON limit (see app.setup.ts). */
export const MAX_COVERAGE_ID_LENGTH = 64;
// Strict. A repeated id is allowed and counts once. The array length is checked before de-duplication.
const coverageBody = z
  .strictObject({ itemIds: z.array(z.string().min(1).max(MAX_COVERAGE_ID_LENGTH)).max(MAX_COVERAGE_IDS).optional() })
  .optional();
type CoverageBody = z.infer<typeof coverageBody>;

function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}

/** A module with no mapping yet (or an unknown name) is a 404, like an unknown route. */
function mappingFor(module: string): ContentModuleMapping {
  const mapping = contentMappingFor(module);
  if (!mapping) throw new ApiError(404, "not_found", "No such endpoint.");
  return mapping;
}

/** The uploaded file's name for the receipt: base name only, safe characters, at most 200. Never a path. */
export function sanitiseFileName(raw: string | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._()+-]/gu, "_")
    .replace(/^[. ]+/, "")
    .trim()
    .slice(0, 200);
  return cleaned === "" ? "import.xlsx" : cleaned;
}

/**
 * Staff-only content administration. Not exempt from auth or rate limiting; exempt from the client
 * version gate, because the website that calls it has no app build number.
 */
@StaffOnly()
@SkipClientVersion()
@Controller("v1/admin/content")
export class ContentController {
  constructor(private readonly content: ContentService) {}

  /**
   * Import a staff-edited xlsx (raw bytes; the route-scoped parser in app.setup.ts reads at most 5 MB).
   * dryRun=true plans only (200) and returns the planHash. Otherwise 201 on apply, 200 `replayed: true` for
   * bytes already imported. A client sheet that would update or retire stored items needs ?confirm=<planHash>.
   */
  @Post(":module/imports")
  async importFile(
    @Principal() principal: string,
    @Param("module") module: string,
    @Query(new ZodValidationPipe(importQuery, "Expected ?dryRun=true|false and an optional ?confirm=<64 hex planHash>.")) query: ImportQuery,
    @Headers("x-file-name") fileName: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const mapping = mappingFor(module);
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ApiError(400, "invalid_request", `Expected the .xlsx file as the request body with Content-Type ${XLSX_MIME}.`);
    }
    if (query.dryRun === "true") {
      if (query.confirm !== undefined) throw new ApiError(400, "invalid_request", "confirm applies to a real import, not a dry run.");
      res.status(200);
      return this.content.dryRun(mapping, body);
    }
    const result = await this.content.apply(mapping, body, sanitiseFileName(fileName), principal, new Date(), query.confirm);
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /**
   * Per-rank Trip coverage of the module's approved items (B3 `tripCoverage`), optionally for a subset. Read-only,
   * so 200. A module with a mapping but no deal policy is 404 (the server does not deal it).
   */
  @Post(":module/trip-coverage")
  @HttpCode(200)
  async tripCoverage(
    @Param("module") module: string,
    @Headers("content-type") contentType: string | undefined,
    @Headers("content-length") contentLength: string | undefined,
    @Headers("transfer-encoding") transferEncoding: string | undefined,
    @Body(new ZodValidationPipe(coverageBody, `Expected {} or { itemIds: up to ${MAX_COVERAGE_IDS} item id strings }.`)) body: CoverageBody,
  ) {
    // A body that is not JSON was not parsed, so its itemIds would be silently ignored: refuse it instead.
    const hasBody = transferEncoding !== undefined || (contentLength !== undefined && contentLength !== "0");
    if (hasBody && !/^application\/json\s*(;|$)/i.test(contentType ?? "")) {
      throw new ApiError(415, "invalid_request", "Send the body as application/json.");
    }
    const mapping = mappingFor(module);
    if (!isModuleId(mapping.module) || !Object.hasOwn(DEAL_POLICY, mapping.module)) {
      throw new ApiError(404, "not_found", "No such endpoint.");
    }
    return this.content.tripCoverage(mapping.module, body?.itemIds);
  }

  @Get(":module/items")
  async items(@Param("module") module: string) {
    mappingFor(module);
    return { items: await this.content.listItems(module) };
  }

  @Get(":module/export")
  async export(@Param("module") module: string, @Res({ passthrough: true }) res: Response) {
    const mapping = mappingFor(module);
    const bytes = await this.content.exportWorkbook(mapping);
    res.setHeader("Cache-Control", "no-store");
    const date = new Date().toISOString().slice(0, 10);
    return new StreamableFile(bytes, { type: XLSX_MIME, disposition: `attachment; filename="${module}-${date}.xlsx"` });
  }
}
