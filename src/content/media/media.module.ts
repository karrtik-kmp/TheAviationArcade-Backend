import { Module } from "@nestjs/common";
import { MediaController } from "./media.controller.js";
import { MediaGuestController } from "./media-guest.controller.js";
import { MediaPublicController } from "./media-public.controller.js";
import { MediaService } from "./media.service.js";

@Module({
  controllers: [MediaController, MediaPublicController, MediaGuestController],
  providers: [MediaService],
})
export class MediaModule {}
