import { Controller, Get } from "@nestjs/common";

/** Public liveness probe. Deliberately does not touch the database. */
@Controller("v1/health")
export class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}
