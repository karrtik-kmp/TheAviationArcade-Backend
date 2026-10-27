import { Module } from "@nestjs/common";
import { FirebaseAuthGuard } from "./firebase-auth.guard.js";

@Module({
  providers: [FirebaseAuthGuard],
  exports: [FirebaseAuthGuard],
})
export class AuthModule {}
