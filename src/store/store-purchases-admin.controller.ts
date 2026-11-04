import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { AccountPrincipalPipe } from "../accounts/accounts.controller.js";
import { uidOfAccountPrincipal } from "../accounts/account-principal.js";
import { Roles } from "../auth/roles.js";
import { ApiError } from "../common/errors.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { STORES } from "../db/enums.js";
import { SkipClientVersion } from "../platform/client-version.js";
import { PRODUCT_ID_PATTERN } from "./store-admin.controller.js";
import { StorePurchasesAdminService } from "./store-purchases-admin.service.js";

export const PURCHASES_DEFAULT_LIMIT = 50;
export const PURCHASES_MAX_LIMIT = 100;

const emptyQuery = z.strictObject({});

/**
 * Every field is a single non-empty string: a repeated key (an array), an empty value or a nested key fails the strict schema.
 * `player` must be a principal of the configured project, so another project's principal is 400, not an empty page.
 */
function purchasesQuery(projectId: string) {
  return z.strictObject({
    player: z
      .string()
      .max(200)
      .refine((value) => uidOfAccountPrincipal(value, projectId) !== undefined)
      .optional(),
    productId: z.string().regex(PRODUCT_ID_PATTERN).optional(),
    store: z.enum(STORES).optional(),
    transactionRef: z.string().regex(/^[A-Za-z0-9._~:-]{1,1024}$/).optional(),
    orderId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
    cursor: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
    limit: z.string().regex(/^[0-9]{1,3}$/).optional(),
  });
}
type PurchasesQuery = z.infer<ReturnType<typeof purchasesQuery>>;

/** Staff read of purchases and entitlements (`@Roles("admin")`; wave P-D of docs/plans/purchases.md). Read only. */
@Roles("admin")
@SkipClientVersion()
@Controller("v1/admin/store")
export class StorePurchasesAdminController {
  private readonly queryPipe: ZodValidationPipe<ReturnType<typeof purchasesQuery>>;

  constructor(
    private readonly service: StorePurchasesAdminService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.queryPipe = new ZodValidationPipe(
      purchasesQuery(config.firebaseProjectId),
      "Expected ?player (a principal), ?productId, ?store=apple|google, ?transactionRef, ?orderId, ?cursor and ?limit (1-100), each once and never empty.",
    );
  }

  @Get("purchases")
  async list(@Query() rawQuery: unknown) {
    const query: PurchasesQuery = this.queryPipe.transform(rawQuery);
    const limit = query.limit === undefined ? PURCHASES_DEFAULT_LIMIT : Number(query.limit);
    if (limit < 1 || limit > PURCHASES_MAX_LIMIT) throw new ApiError(400, "invalid_request", "limit must be 1 to 100.");
    return this.service.listPurchases(
      {
        player: query.player,
        productId: query.productId,
        store: query.store,
        transactionRef: query.transactionRef,
        orderId: query.orderId,
      },
      query.cursor,
      limit,
    );
  }

  @Get("players/:principal/entitlements")
  async entitlements(
    @Param("principal", AccountPrincipalPipe) principal: string,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
  ) {
    const view = await this.service.entitlements(principal);
    if (!view) throw new ApiError(404, "player_not_found", "No such player.");
    return view;
  }
}
