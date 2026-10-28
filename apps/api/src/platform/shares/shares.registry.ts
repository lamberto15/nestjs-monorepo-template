import { Injectable } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * A feature whose records can be shared by a read-only link (the `share`
 * capability; RecordShares for a declared record). Register from the
 * constructor: `shares.register(this)`. The platform asks it both when a
 * link is made and every time one is opened, with its maker as they are
 * now: a link never shows more than its maker may still read.
 */
export interface ShareTarget {
  /** The records' permission subject: `Note`. */
  readonly subject: string;
  /** The fields a link may show: the declared ones, never a reference to another record. */
  readonly fields: readonly string[];
  /** Whether the records take attachments (a link may then list the files). */
  readonly files: boolean;
  /** Throws unless the principal may share the record: a 404 when it doesn't exist or they may not read it, a 403 when they read but may not share it. */
  assertCanShare(principal: Principal, recordId: string): Promise<void>;
  /**
   * The record's `fields`, as reading it would show them to `principal`
   * (field-level permissions: a field they may not read is left out), or
   * null when it is gone (or in the recycle bin) or they may no longer read
   * or share it.
   */
  shared(
    principal: Principal,
    recordId: string,
    fields: readonly string[],
  ): Promise<Record<string, unknown> | null>;
}

@Injectable()
export class SharesRegistry {
  private readonly targets = new Map<string, ShareTarget>();

  register(target: ShareTarget) {
    if (this.targets.has(target.subject)) {
      throw new Error(`Two share targets are for "${target.subject}".`);
    }
    this.targets.set(target.subject, target);
  }

  /** The registered target of a subject, or undefined. */
  find(subject: string): ShareTarget | undefined {
    return this.targets.get(subject);
  }
}
