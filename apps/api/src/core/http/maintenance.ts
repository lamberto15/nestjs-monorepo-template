import { SetMetadata } from '@nestjs/common';

export const ALLOW_IN_MAINTENANCE = Symbol('allow-in-maintenance');

/**
 * A route (or controller) that keeps answering while the app is read-only
 * or in maintenance (`platform.mode`, docs/settings.md): health and metrics,
 * signing in and out, `GET /features`, the operators' routes and the one that
 * turns the mode off. Everything else is refused by the platform's
 * ModeGuard. Lives in core so core's controllers can use it; the guard reads it.
 */
export const AllowInMaintenance = (allowed = true) =>
  SetMetadata(ALLOW_IN_MAINTENANCE, allowed);
