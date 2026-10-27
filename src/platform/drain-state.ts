import { Global, Injectable, Module } from "@nestjs/common";

/**
 * Set once shutdown begins. While true, /v1/health/ready is 503 (so load balancers stop routing here)
 * and every response carries `Connection: close` (so keep-alive sockets are not reused).
 */
@Injectable()
export class DrainState {
  draining = false;
}

@Global()
@Module({ providers: [DrainState], exports: [DrainState] })
export class PlatformModule {}
