import { Injectable } from '@nestjs/common';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { ScaledThrottlerGuard } from './scaled-throttler.guard.js';

/**
 * Per IP everywhere; per (email, IP) where the request body names an account,
 * so guessing one account's password is limited without locking others out.
 * Registered globally by CoreModule, ahead of the authentication guard:
 * guessed credentials count against the limit too. Realtime messages count
 * per connection address (the docs' WebSocket guard, for socket.io). Every
 * limit is multiplied by RATE_LIMIT_MULTIPLIER (ScaledThrottlerGuard).
 */
@Injectable()
export class AppThrottlerGuard extends ScaledThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const ip = await super.getTracker(req);
    const email =
      typeof req.body?.email === 'string'
        ? req.body.email.trim().normalize('NFC').toLowerCase()
        : '';
    return email ? `${email}|${ip}` : ip;
  }

  protected async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    const { context, ttl, throttler, blockDuration, generateKey } =
      requestProps;
    if (context.getType() !== 'ws') {
      return super.handleRequest(requestProps);
    }
    const limit = this.scaled(requestProps.limit);
    const client = context
      .switchToWs()
      .getClient<{ conn: { remoteAddress: string } }>();
    const tracker = client.conn.remoteAddress;
    const key = generateKey(context, tracker, throttler.name!);
    const { totalHits, timeToExpire, isBlocked, timeToBlockExpire } =
      await this.storageService.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttler.name!,
      );
    if (isBlocked) {
      await this.throwThrottlingException(context, {
        limit,
        ttl,
        key,
        tracker,
        totalHits,
        timeToExpire,
        isBlocked,
        timeToBlockExpire,
      });
    }
    return true;
  }
}
