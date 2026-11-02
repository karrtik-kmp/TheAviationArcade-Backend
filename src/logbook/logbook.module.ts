import { Module } from "@nestjs/common";
import { LogbookController } from "./logbook.controller.js";
import { LogbookService } from "./logbook.service.js";

/** Read-only: no PlayerBalance, no writes (slice T5). */
@Module({
  controllers: [LogbookController],
  providers: [LogbookService],
})
export class LogbookModule {}
