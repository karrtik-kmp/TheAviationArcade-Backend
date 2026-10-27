import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "isPublic";

/** Opts a route out of the global FirebaseAuthGuard. Only the health probe uses it. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
