import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiError } from "../../common/errors.js";
import { ContentDocumentsService } from "./content-documents.service.js";
import { isDocumentName } from "./documents.js";

/** Manifest: store, but revalidate with If-None-Match. Documents: the bytes of a (name, version) never change. Both are exceptions to the global `/v1` no-store (design 7). */
export const MANIFEST_CACHE_CONTROL = "no-cache";
export const DOCUMENT_CACHE_CONTROL = "private, max-age=31536000, immutable";

/**
 * RFC 9110 `If-None-Match` for a GET: `*` matches any current representation, otherwise any listed tag equal to `etag`
 * under WEAK comparison (a `W/` prefix is ignored) matches. `etag` is the quoted strong tag we sent.
 */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = header.trim();
  if (value === "*") return true;
  return value.split(",").some((part) => part.trim().replace(/^W\//, "") === etag);
}

const VERSION = /^[1-9]\d{0,8}$/;

/**
 * The pull manifest and its immutable documents, for any signed-in caller (U11). The version gate and the rate limiter
 * apply as to every app route: the Unity client sends `X-Client-Version`, and a 304 still counts against the limit.
 */
@Controller("v1/content")
export class ContentDocumentsController {
  constructor(private readonly documents: ContentDocumentsService) {}

  @Get("manifest")
  async manifest(@Req() req: Request, @Res() res: Response): Promise<void> {
    const manifest = await this.documents.manifest();
    const etag = `"${manifest.version}"`;
    res.setHeader("Cache-Control", MANIFEST_CACHE_CONTROL);
    res.setHeader("ETag", etag);
    if (ifNoneMatchHits(req.header("if-none-match"), etag)) {
      res.status(304).end();
      return;
    }
    res.status(200).json(manifest);
  }

  /** An unknown name, or a version that is not a positive integer or is not stored, is 404 `not_found`. */
  @Get("documents/:name/:version")
  async document(
    @Req() req: Request,
    @Res() res: Response,
    @Param("name") name: string,
    @Param("version") version: string,
  ): Promise<void> {
    if (!isDocumentName(name) || !VERSION.test(version)) throw new ApiError(404, "not_found", "No such document.");
    const served = await this.documents.document(name, Number(version));
    const etag = `"${served.sha256}"`;
    const notModified = ifNoneMatchHits(req.header("if-none-match"), etag);
    // Verify first: a corrupt row answers 500 under the global no-store, never under the immutable cache header.
    const bytes = notModified ? undefined : served.load();
    res.setHeader("Cache-Control", DOCUMENT_CACHE_CONTROL);
    res.setHeader("ETag", etag);
    if (bytes === undefined) {
      res.status(304).end();
      return;
    }
    res.status(200).type("application/json; charset=utf-8").send(bytes);
  }
}
