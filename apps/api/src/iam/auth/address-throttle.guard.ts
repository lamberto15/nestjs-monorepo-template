import { createHash } from 'node:crypto';
import {
  applyDecorators,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ScaledThrottlerGuard } from '../../core/http/scaled-throttler.guard.js';

export interface AddressThrottleOptions {
  /**
   * The budget's name: every route with the same name draws from one
   * count per address (`passkey`: the options and the answers of the
   * passkey sign-in together). Also the throttler's name in the 429's
   * `Retry-After-<name>` header.
   */
  name: string;
  /** Requests per `ttl` from one address, across the routes of `name`. */
  limit: number;
  /** The window, in milliseconds (`minutes(15)`). */
  ttl: number;
}

const ADDRESS_THROTTLE = Symbol('address-throttle');

/**
 * A limit per address shared by a group of routes, whatever their bodies
 * say: for ceremonies where the global guard's `email|address` key
 * (AppThrottlerGuard) is the wrong one. A usernameless passkey sign-in
 * names no email, and a sign-in that names one may name a new one each
 * time; either way only the address identifies the caller. Counted in the
 * same storage (Redis) under the throttler `name`; past the limit, 429
 * `rate_limited`. RATE_LIMIT_MULTIPLIER raises it too.
 *
 * Custom: @nestjs/throttler's keys are per route (class and handler in the
 * key), and its tracker is the global guard's; this guard counts one key
 * per group and address.
 */
export const AddressThrottle = (options: AddressThrottleOptions) =>
  applyDecorators(
    SetMetadata(ADDRESS_THROTTLE, options),
    UseGuards(AddressThrottlerGuard),
  );

@Injectable()
export class AddressThrottlerGuard extends ScaledThrottlerGuard {
  override async canActivate(context: ExecutionContext) {
    const options = this.reflector.getAllAndOverride<
      AddressThrottleOptions | undefined
    >(ADDRESS_THROTTLE, [context.getHandler(), context.getClass()]);
    if (!options || context.getType() !== 'http') {
      return true;
    }
    return this.handleRequest({
      context,
      limit: options.limit,
      ttl: options.ttl,
      blockDuration: options.ttl,
      throttler: {
        name: options.name,
        limit: options.limit,
        ttl: options.ttl,
      },
      // The address as the global guard sees it (trusted proxies applied), without the email.
      getTracker: (req) => super.getTracker(req),
      generateKey: (_context, tracker, name) =>
        createHash('sha256').update(`address:${name}:${tracker}`).digest('hex'),
    });
  }
}
