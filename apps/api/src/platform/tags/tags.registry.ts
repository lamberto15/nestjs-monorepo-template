import { Injectable } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * A feature whose records carry tags. Register from the constructor:
 * `tags.register(this)`. The platform asks it who may change a record's
 * tags; tags of an unregistered subject can't be created (400).
 *
 * ```ts
 * readonly subject = 'Note';
 * async canTag(principal, id) { return this.policy.update(principal, await this.notes.findOne(id, undefined, { visibleTo: principal })); }
 * ```
 */
export interface TagTarget {
  /** The records' permission subject: `Note`. */
  readonly subject: string;
  /** Whether the principal may change the record's tags; a 404 (thrown) when it doesn't exist or they may not read it (the same 404). */
  canTag(principal: Principal, recordId: string): Promise<boolean>;
}

@Injectable()
export class TagsRegistry {
  private readonly targets = new Map<string, TagTarget>();

  register(target: TagTarget) {
    if (this.targets.has(target.subject)) {
      throw new Error(`Two tag targets are for "${target.subject}".`);
    }
    this.targets.set(target.subject, target);
  }

  /** The registered target of a subject, or undefined. */
  find(subject: string): TagTarget | undefined {
    return this.targets.get(subject);
  }

  /** The subjects whose records take tags. */
  subjects() {
    return [...this.targets.keys()];
  }
}
