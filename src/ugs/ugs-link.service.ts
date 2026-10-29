import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { AuthUnavailableError } from "../auth/firebase.js";
import { PlayerBalance } from "../balance/player-balance.js";
import { ApiError } from "../common/errors.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig, UgsConfig } from "../config/config.module.js";
import { rootCause } from "../database/database-errors.js";
import { DatabaseService } from "../database/database.module.js";
import { players, ugsLinks } from "../db/schema.js";
import { LINK_PROOFS_PER_HOUR, SlidingWindowLimiter, TokenBucket } from "./mirror-policy.js";
import { UgsClient } from "./ugs-client.js";
import type { ExternalId } from "./ugs-client.js";
import { InvalidUgsTokenError, verifyUgsToken } from "./ugs-token.js";
import { UGS_CLIENT, UGS_KEYS, UGS_PROOF_BUCKET } from "./ugs.tokens.js";
import type { UgsKeys } from "./ugs.tokens.js";

export type LinkOutcome = { created: boolean; linkedAt: Date };

/**
 * PUT /v1/me/ugs-link. Proves, server-side, that a UGS player is this Firebase user, then records the link.
 * The only inputs are the verified Firebase principal and a UGS token; a client-supplied player id is never
 * accepted. Proof = (1) the UGS token verifies for this project/environment, (2) Player Auth admin lists an
 * external identity on that UGS player whose provider is our OIDC provider and whose id is the Firebase uid.
 *
 * The admin API is the scarce resource (500 calls / 30 min per project), so a verified token for the UGS player
 * this principal is already linked to answers 200 without calling it; every other attempt is throttled per
 * principal (5 per hour) and by a process-wide token bucket (503 + Retry-After when empty).
 */
@Injectable()
export class UgsLinkService {
  private readonly logger = new Logger("UgsLink");
  private readonly perPrincipal = new SlidingWindowLimiter(LINK_PROOFS_PER_HOUR, 60 * 60_000);

  constructor(
    private readonly database: DatabaseService,
    private readonly balance: PlayerBalance,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(UGS_CLIENT) private readonly client: UgsClient | null,
    @Inject(UGS_KEYS) private readonly keys: UgsKeys,
    @Inject(UGS_PROOF_BUCKET) private readonly proofBucket: TokenBucket,
  ) {}

  private uidOf(principal: string): string {
    const prefix = `firebase:${this.config.firebaseProjectId}:`;
    if (!principal.startsWith(prefix)) throw new Error("Principal does not belong to this Firebase project.");
    return principal.slice(prefix.length);
  }

  async link(principal: string, ugsToken: string, now: Date): Promise<LinkOutcome> {
    const ugs: UgsConfig | undefined = this.config.ugs;
    if (!ugs || !this.client) {
      throw new ApiError(404, "not_found", "The UGS progress mirror is not enabled on this server.");
    }
    const [player] = await this.database.db.select({ id: players.id }).from(players).where(eq(players.id, principal));
    if (!player) throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");

    let ugsPlayerId: string;
    try {
      ({ ugsPlayerId } = await verifyUgsToken(ugsToken, { projectId: ugs.projectId, environmentId: ugs.environmentId }, this.keys));
    } catch (error) {
      if (error instanceof AuthUnavailableError) {
        throw new ApiError(503, "auth_unavailable", "UGS sign-in keys are temporarily unavailable. Retry shortly.", { "Retry-After": "5" });
      }
      if (error instanceof InvalidUgsTokenError) throw new ApiError(400, "invalid_request", error.message);
      throw error;
    }

    // Already linked to exactly this UGS player: nothing to prove again, nothing to change.
    const [current] = await this.database.db.select().from(ugsLinks).where(eq(ugsLinks.playerId, principal));
    if (current && current.ugsPlayerId === ugsPlayerId) return { created: false, linkedAt: current.linkedAt };

    const wait = this.perPrincipal.hit(principal, now.getTime());
    if (wait > 0) {
      throw new ApiError(429, "rate_limited", "Too many link attempts. Try again later.", { "Retry-After": String(wait) });
    }
    if (!this.proofBucket.take(now.getTime())) {
      this.logger.warn({ event: "ugs_link_proof_budget_empty" });
      throw new ApiError(503, "service_unavailable", "UGS is busy. Retry shortly.", { "Retry-After": "5" });
    }
    const proof = await this.client.getExternalIds(ugsPlayerId);
    if (proof.kind === "unavailable") {
      // Includes our own credentials being rejected (401/403): an operator problem, not the player's.
      this.logger.warn({ event: "ugs_link_proof_unavailable", status: proof.status });
      throw new ApiError(503, "service_unavailable", "UGS is temporarily unavailable. Retry shortly.", { "Retry-After": "5" });
    }
    const uid = this.uidOf(principal);
    const proven =
      proof.kind === "ok" && proof.externalIds.some((entry) => entry.providerId === ugs.oidcProvider && entry.externalId === uid);
    if (!proven) throw new ApiError(403, "forbidden", "UGS account is not linked to this sign-in");

    try {
      return await this.record(principal, ugsPlayerId, now);
    } catch (error) {
      if (error instanceof LinkHeldError) {
        // Re-checked against the identities just fetched: if the UGS player no longer carries the holder's uid,
        // the holder's link is stale (the UGS player belongs to this sign-in now) and moves to the caller.
        const identities = proof.kind === "ok" ? proof.externalIds : [];
        if (this.holderStillProven(error.holder, identities)) throw conflict();
        return this.record(principal, ugsPlayerId, now, error.holder).catch((retry: unknown) => this.mapRecordError(retry));
      }
      return this.mapRecordError(error);
    }
  }

  private mapRecordError(error: unknown): never {
    if (error instanceof LinkHeldError) throw conflict();
    if (error instanceof ApiError) throw error;
    // Another principal linked the same UGS id between our check and the insert.
    if ((rootCause(error) as { code?: unknown } | null)?.code === "23505") throw conflict();
    throw error;
  }

  /** True when the holder's own uid is still an external identity of the UGS player. A foreign holder counts as proven. */
  private holderStillProven(holder: string, externalIds: ExternalId[]): boolean {
    const prefix = `firebase:${this.config.firebaseProjectId}:`;
    if (!holder.startsWith(prefix)) return true;
    const holderUid = holder.slice(prefix.length);
    const provider = this.config.ugs?.oidcProvider;
    return externalIds.some((entry) => entry.providerId === provider && entry.externalId === holderUid);
  }

  /** Writes go through PlayerBalance.linkUgs (player lock, link rows, version rule, enqueue). The proof is already done. */
  private async record(principal: string, ugsPlayerId: string, now: Date, moveFrom?: string): Promise<LinkOutcome> {
    const result = await this.balance.linkUgs(principal, ugsPlayerId, now, moveFrom);
    if (result.kind === "no_player") throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
    if (result.kind === "held") throw new LinkHeldError(result.holder);
    return { created: result.created, linkedAt: result.linkedAt };
  }
}

function conflict(): ApiError {
  return new ApiError(409, "ugs_link_conflict", "That UGS account is already linked to another player.");
}

/** Internal: the UGS id is linked to `holder`. Becomes a 409 unless the holder's proof is found stale. */
class LinkHeldError extends Error {
  constructor(readonly holder: string) {
    super("UGS id is linked to another player.");
  }
}
