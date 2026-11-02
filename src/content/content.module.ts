import { Module } from "@nestjs/common";
import { ContentDocumentsController } from "./documents/content-documents.controller.js";
import { ContentDocumentsService } from "./documents/content-documents.service.js";
import { ContentController } from "./content.controller.js";
import { ContentService } from "./content.service.js";

@Module({
  controllers: [ContentController, ContentDocumentsController],
  providers: [ContentService, ContentDocumentsService],
})
export class ContentModule {}
