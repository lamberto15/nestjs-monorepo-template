import { Injectable } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * A feature whose records can be watched (`POST /<path>/{id}/watch`).
 * Register from the constructor: `subscriptions.register(this)`. The
 * platform asks it before a principal starts watching a record.
 *
 * ```ts
 * readonly subject = 'Note';
 * async assertCanWatch(principal, id) {
 *   await this.authorization.authorize(NotePolicy, 'read', principal, await this.notes.findOne(id));
 * }
 * ```
 */
export interface SubscriptionTarget {
  /** The records' permission subject: `Note`. */
  readonly subject: string;
  /** Throws unless the principal may watch the record (a 404 when it doesn't exist, a 403 when they may not read it). */
  assertCanWatch(principal: Principal, recordId: string): Promise<void>;
}

@Injectable()
export class SubscriptionsRegistry {
  private readonly targets = new Map<string, SubscriptionTarget>();

  register(target: SubscriptionTarget) {
    if (this.targets.has(target.subject)) {
      throw new Error(`Two subscription targets are for "${target.subject}".`);
    }
    this.targets.set(target.subject, target);
  }

  /** The registered target of a subject, or undefined. */
  find(subject: string): SubscriptionTarget | undefined {
    return this.targets.get(subject);
  }
}
