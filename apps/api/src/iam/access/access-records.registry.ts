import { Injectable } from '@nestjs/common';
import type { Principal } from '../auth/principal.js';

/**
 * Finds one record of a subject for the permission explanation
 * (GET /v1/access/users/{id}/explanation?recordId=): the record as its own
 * routes load it, or null when it doesn't exist or `visibleTo` may not read
 * it (the lookup's read filter, as `findOne(id, undefined, { visibleTo })`).
 */
export interface AccessRecordFinder {
  readonly subject: string;
  find(
    id: string,
    visibleTo: Principal,
  ): Promise<Record<string, unknown> | null>;
}

/**
 * The subjects whose records the explanation can check, kept by the
 * features (which IAM can't import): every generated record registers
 * (record-targets.ts, `RecordAccessFinder`), notes by hand. Register from
 * the constructor: `registry.register(this)`.
 */
@Injectable()
export class AccessRecordsRegistry {
  private readonly finders = new Map<string, AccessRecordFinder>();

  register(finder: AccessRecordFinder) {
    if (this.finders.has(finder.subject)) {
      throw new Error(`Two record finders for "${finder.subject}".`);
    }
    this.finders.set(finder.subject, finder);
  }

  /** The subject's finder, or undefined when its records can't be explained. */
  finder(subject: string) {
    return this.finders.get(subject);
  }
}
