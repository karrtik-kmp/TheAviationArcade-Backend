import { Module } from "@nestjs/common";
import { EditorialAdminController } from "./editorial-admin.controller.js";
import { EditorialPublicController } from "./editorial-public.controller.js";
import { EditorialService } from "./editorial.service.js";

@Module({
  controllers: [EditorialAdminController, EditorialPublicController],
  providers: [EditorialService],
})
export class EditorialModule {}
