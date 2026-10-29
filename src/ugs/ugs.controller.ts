import { Body, Controller, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { Principal } from "../auth/firebase-auth.guard.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { UgsLinkService } from "./ugs-link.service.js";

const linkBody = z.strictObject({ ugsToken: z.string().min(1).max(8000) });
type LinkBody = z.infer<typeof linkBody>;

@Controller("v1/me")
export class UgsController {
  constructor(private readonly links: UgsLinkService) {}

  /**
   * Link this sign-in to its Unity Gaming Services player so the server can mirror progress there (read-only
   * for the game). 201 first link, 200 when already linked to that UGS player or when re-pointed to another.
   */
  @Put("ugs-link")
  async link(
    @Principal() principal: string,
    @Body(new ZodValidationPipe(linkBody, "Expected { ugsToken }.")) body: LinkBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    const outcome = await this.links.link(principal, body.ugsToken, new Date());
    res.status(outcome.created ? 201 : 200);
    return { link: { linkedAt: outcome.linkedAt.toISOString() } };
  }
}
