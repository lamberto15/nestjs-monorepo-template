import {
  applyDecorators,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ScaledThrottlerGuard } from '../../core/http/scaled-throttler.guard.js';
import type { RequestPrincipal } from './principal.js';

export interface UserThrottleOptions {
  /** Requests per `ttl` from one signed-in user. */
  limit: number;
  /** The window, in milliseconds (`minutes(15)`). */
  ttl: number;
}

const USER_THROTTLE = Symbol('user-throttle');

/**
 * A limit per signed-in user, on top of the global guard's per address
 * (AppThrottlerGuard): for a route that takes no email (the user is known
 * from the credential), so guessing one account's password from many
 * addresses is limited too. Counted in the same storage (Redis), under the
 * throttler name `user`; past the limit, 429 `rate_limited` with
 * `Retry-After-user`.
 *
 * Custom: the global guard runs before authentication, when the request has
 * no user yet, and the throttler's named throttlers apply to every route.
 * This one runs after the authentication guard, on the routes that ask.
 * RATE_LIMIT_MULTIPLIER raises it too (ScaledThrottlerGuard).
 */
export const UserThrottle = (options: UserThrottleOptions) =>
  applyDecorators(
    SetMetadata(USER_THROTTLE, options),
    UseGuards(UserThrottlerGuard),
  );

@Injectable()
export class UserThrottlerGuard extends ScaledThrottlerGuard {
  override async canActivate(context: ExecutionContext) {
    const options = this.reflector.getAllAndOverride<
      UserThrottleOptions | undefined
    >(USER_THROTTLE, [context.getHandler(), context.getClass()]);
    if (!options || context.getType() !== 'http') {
      return true;
    }
    const { req } = this.getRequestResponse(context);
    const user = (req as { user?: RequestPrincipal | null }).user;
    if (user?.kind !== 'user') {
      return true; // nobody to count for: the route's own guards decide
    }
    return this.handleRequest({
      context,
      limit: options.limit,
      ttl: options.ttl,
      blockDuration: options.ttl,
      throttler: { name: 'user', limit: options.limit, ttl: options.ttl },
      getTracker: async () => `user:${user.id}`,
      generateKey: (ctx, tracker, name) => this.generateKey(ctx, tracker, name),
    });
  }
}
