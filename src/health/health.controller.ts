import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator.js";

/** Public liveness probe. Deliberately does not touch the database. */
@Controller("v1/health")
export class HealthController {
  @Public()
  @Get()
  health() {
    return { ok: true };
  }
}
