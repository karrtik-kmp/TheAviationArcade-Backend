import { Module } from "@nestjs/common";
import { ContentAdminController } from "./documents/content-admin.controller.js";
import { ContentAdminService } from "./documents/content-admin.service.js";
import { ContentDocumentsController } from "./documents/content-documents.controller.js";
import { ContentDocumentsService } from "./documents/content-documents.service.js";
import { ContentController } from "./content.controller.js";
import { ContentItemEditService } from "./content-item-edit.service.js";
import { ContentService } from "./content.service.js";

@Module({
  controllers: [ContentController, ContentAdminController, ContentDocumentsController],
  providers: [ContentService, ContentItemEditService, ContentDocumentsService, ContentAdminService],
})
export class ContentModule {}
