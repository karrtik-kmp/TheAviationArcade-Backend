import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { z } from "zod";
import { Principal } from "../auth/firebase-auth.guard.js";
import { ApiError } from "../common/errors.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { progressView } from "../players/progress-view.js";
import { EntitlementsService } from "./entitlements.service.js";
import { PurchasesService } from "./purchases.service.js";
import type { StoreReference } from "./store-verifier.js";

const productId = z.string().regex(/^[a-z0-9][a-z0-9._]{0,99}$/);

// Strict per-store bodies. The body names a reference only; the grant always comes from the server's catalog.
const purchaseBody = z.discriminatedUnion("store", [
  z.strictObject({
    store: z.literal("apple"),
    productId,
    transactionId: z.string().regex(/^[A-Za-z0-9._~-]{1,256}$/),
    jws: z.string().max(12288).optional(),
  }),
  z.strictObject({
    store: z.literal("google"),
    productId,
    purchaseToken: z.string().regex(/^[A-Za-z0-9._~:-]{1,1024}$/),
  }),
]);

@Controller("v1")
export class PurchasesController {
  constructor(
    private readonly purchases: PurchasesService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** The commerce token (created on first read) and First Class Pass state. */
  @Get("me/entitlements")
  async getEntitlements(@Principal() principal: string) {
    const view = await this.entitlements.get(principal);
    if (!view) throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
    return view;
  }

  /** Verify a store purchase with the store and grant it once. The store reference is the idempotency key; Idempotency-Key is ignored. */
  @Post("purchases")
  @HttpCode(200)
  async submit(
    @Principal() principal: string,
    @Body(new ZodValidationPipe(purchaseBody, "Expected { store, productId, transactionId } or { store, productId, purchaseToken }.")) body: StoreReference,
  ) {
    const outcome = await this.purchases.submit(principal, body);
    switch (outcome.kind) {
      case "no_player":
        throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
      case "unavailable":
        throw new ApiError(503, "store_unavailable", "The store could not be reached. Keep the purchase pending and retry.", {
          "Retry-After": String(outcome.retryAfterSec),
        });
      case "invalid":
        throw new ApiError(422, "purchase_invalid", "The store does not confirm this purchase.");
      case "revoked":
        throw new ApiError(422, "purchase_revoked", "The store refunded or revoked this purchase.");
      case "owned_by_other":
        throw new ApiError(409, "purchase_owned_by_other", "This purchase belongs to another account.");
      case "pending":
        return { status: "pending", replayed: false, storePurchase: null, progress: progressView(outcome.player) };
      case "granted": {
        const { record } = outcome;
        return {
          status: "granted",
          replayed: outcome.replayed,
          storePurchase: {
            store: record.store,
            productId: record.productId,
            kind: record.kind,
            environment: record.environment,
            purchasedAt: record.purchasedAt.toISOString(),
            grantedHints: record.grantedHints,
            grantedUntil: record.grantedUntil?.toISOString() ?? null,
          },
          progress: progressView(outcome.player),
        };
      }
    }
  }
}
