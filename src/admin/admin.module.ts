import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller.js";
import { AuditReadService } from "./audit-read.js";

@Module({ controllers: [AdminController], providers: [AuditReadService] })
export class AdminModule {}
