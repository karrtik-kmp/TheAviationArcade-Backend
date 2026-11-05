import { Module } from "@nestjs/common";
import { ContentAdminController } from "./documents/content-admin.controller.js";
import { ContentAdminService } from "./documents/content-admin.service.js";
import { ContentDocumentsController } from "./documents/content-documents.controller.js";
import { ContentDocumentsService } from "./documents/content-documents.service.js";
import { ContentController } from "./content.controller.js";
import { ContentItemEditService } from "./content-item-edit.service.js";
import { ContentService } from "./content.service.js";
import { ReleaseStore } from "./releases/release-store.js";
import { ReleasesController } from "./releases/releases.controller.js";

@Module({
  controllers: [ContentController, ContentAdminController, ContentDocumentsController, ReleasesController],
  providers: [ContentService, ContentItemEditService, ContentDocumentsService, ContentAdminService, ReleaseStore],
})
export class ContentModule {}
