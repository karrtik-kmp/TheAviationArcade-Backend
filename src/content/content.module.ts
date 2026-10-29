import { Module } from "@nestjs/common";
import { ContentController } from "./content.controller.js";
import { ContentService } from "./content.service.js";

@Module({
  controllers: [ContentController],
  providers: [ContentService],
})
export class ContentModule {}
