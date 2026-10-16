import { HttpException } from '@nestjs/common';
import { problemCode } from '../../core/http/problem-details.filter.js';
import { refusal } from '../data-transfer/data-transfer.processor.js';
import type {
  BulkItemError,
  BulkItemResult,
  BulkResult,
} from './bulk.types.js';

/**
 * An item's failure, from what its action threw: a 4xx (Nest's exceptions,
 * as the feature's route answers them) with its code, message and field
 * errors. Undefined for anything else (the database gone): that stops the run.
 */
export function itemError(error: unknown): BulkItemError | undefined {
  // The fields the import's refusal reads (validation_failed, field_forbidden).
  const refused = refusal(error, 0);
  if (!refused || !(error instanceof HttpException)) {
    return undefined;
  }
  const body = error.getResponse();
  const { code, message } = (
    typeof body === 'object' ? body : { message: body }
  ) as { code?: unknown; message?: unknown };
  const errors = refused
    .filter((issue) => issue.path)
    .map(({ path, message: text }) => ({ path, message: text }));
  return {
    code: typeof code === 'string' ? code : problemCode(error.getStatus()),
    message: typeof message === 'string' ? message : error.message,
    ...(errors.length > 0 && { errors }),
  };
}

/** The result of an id the selection did not yield: not there, or not the caller's to act on. */
export const skipped = (id: string, action: string): BulkItemResult => ({
  id,
  status: 'skipped',
  error: {
    code: 'not_found',
    message: `Not found, or not yours to ${action}.`,
  },
});

/** Counts a run's items exactly, and keeps their results up to `cap`. */
export class BulkTally {
  done = 0;
  failed = 0;
  skipped = 0;
  private readonly results: BulkItemResult[] = [];
  private truncated = false;

  constructor(private readonly cap = Number.POSITIVE_INFINITY) {}

  add(result: BulkItemResult) {
    this[result.status]++;
    if (this.results.length < this.cap) {
      this.results.push(result);
    } else {
      this.truncated = true;
    }
  }

  /** The items acted on so far (skipped ones aside). */
  get processed() {
    return this.done + this.failed;
  }

  /** The outcome; with `ids`, the results in their order (skipped ones where they were asked for). */
  result(ids?: readonly string[]): BulkResult {
    const results = ids
      ? (() => {
          const order = new Map(ids.map((id, index) => [id, index]));
          return [...this.results].sort(
            (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
          );
        })()
      : this.results;
    return {
      done: this.done,
      failed: this.failed,
      skipped: this.skipped,
      results,
      ...(this.truncated && { truncated: true }),
    };
  }
}
