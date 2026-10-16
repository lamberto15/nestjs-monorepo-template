/** The hash field that holds a day's sum, next to one field per route. */
export const TOTAL_FIELD = '_total';

/** How long a day's live counters stay in Redis: the nightly roll-up has two nights to copy them. */
export const LIVE_TTL_SECONDS = 3 * 86_400;

/** A UTC day as `yyyy-mm-dd`. */
export const utcDay = (at: Date = new Date()) => at.toISOString().slice(0, 10);

/** The UTC day `days` after `day` (negative: before). */
export const addDays = (day: string, days: number) =>
  utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000));

/** Every day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string) {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/** Seconds until the next UTC midnight, when daily quotas start again. */
export const secondsToUtcMidnight = (now: Date = new Date()) => {
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
};

/** The live counters of a client's day (without REDIS_PREFIX, which ioredis adds). */
export const usageKey = (clientId: string, day: string) =>
  `usage:${clientId}:${day}`;

/** A usage key's client and day, or undefined for anything else. */
export function parseUsageKey(key: string) {
  const match = /^usage:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/.exec(key);
  return match ? { clientId: match[1], day: match[2] } : undefined;
}

/** A request's route as counted (`GET /v1/notes/{id}`): core's, shared with the metrics. */
export { routeKey } from '../../core/http/route-key.js';
