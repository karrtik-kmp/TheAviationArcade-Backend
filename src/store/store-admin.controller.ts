import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { Principal } from "../auth/firebase-auth.guard.js";
import { Roles } from "../auth/roles.js";
import { ApiError } from "../common/errors.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { STORE_PASS_PERIODS, STORE_PRODUCT_KINDS } from "../db/enums.js";
import { SkipClientVersion } from "../platform/client-version.js";
import { StoreCatalogService } from "./store-catalog.service.js";

export const PRODUCT_ID_PATTERN = /^[a-z0-9][a-z0-9._]{0,99}$/;
const productVersion = z.number().int().min(1).max(2_147_483_647);
const putBody = z.strictObject({
  version: productVersion.optional(),
  kind: z.enum(STORE_PRODUCT_KINDS),
  title: z.string().min(1).max(100),
  hints: z.number().int().min(1).max(1000).optional(),
  passPeriod: z.enum(STORE_PASS_PERIODS).optional(),
  demo: z.boolean(),
});
type PutBody = z.infer<typeof putBody>;
const versionBody = z.strictObject({ version: productVersion });
type VersionBody = z.infer<typeof versionBody>;

/** An id that cannot match the pattern cannot exist: 404 like any unknown id (retire, restore). */
function knownId(productId: string): string {
  if (!PRODUCT_ID_PATTERN.test(productId)) throw new ApiError(404, "not_found", "No such product.");
  return productId;
}

/**
 * Admin-only catalog administration (`@Roles("admin")`, Backend ADR-0002). Not exempt from auth or rate limiting; exempt from the
 * client version gate, like the content admin: the website that calls it has no app build number.
 */
@Roles("admin")
@SkipClientVersion()
@Controller("v1/admin/store/products")
export class StoreAdminController {
  constructor(
    private readonly catalog: StoreCatalogService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  async list() {
    return { products: await this.catalog.listAll() };
  }

  /** 201 on create, 200 on edit or no change. */
  @Put(":productId")
  async put(
    @Principal() principal: string,
    @Param("productId") productId: string,
    @Body(new ZodValidationPipe(putBody, "Expected { version?, kind, title, hints?, passPeriod?, demo } and nothing else.")) body: PutBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!PRODUCT_ID_PATTERN.test(productId)) {
      throw new ApiError(400, "invalid_request", "The product id must match ^[a-z0-9][a-z0-9._]{0,99}$.");
    }
    const { version, ...write } = body;
    const result = await this.catalog.put(principal, productId, version, write, this.config.appEnv);
    res.status(result.created ? 201 : 200);
    return result.product;
  }

  @Post(":productId/retire")
  @HttpCode(200)
  async retire(
    @Principal() principal: string,
    @Param("productId") productId: string,
    @Body(new ZodValidationPipe(versionBody, "Expected { version: integer } and nothing else.")) body: VersionBody,
  ) {
    return this.catalog.setStatus(principal, knownId(productId), body.version, "retired");
  }

  @Post(":productId/restore")
  @HttpCode(200)
  async restore(
    @Principal() principal: string,
    @Param("productId") productId: string,
    @Body(new ZodValidationPipe(versionBody, "Expected { version: integer } and nothing else.")) body: VersionBody,
  ) {
    return this.catalog.setStatus(principal, knownId(productId), body.version, "active");
  }
}
