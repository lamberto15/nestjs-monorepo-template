import { Injectable } from '@nestjs/common';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * A kind of record that takes attachments. The feature decides who may see
 * them (whoever may read the record: list, download) and who may add them
 * (`canWrite`: upload, and removing someone else's). Register from the
 * constructor: `attachments.register(this)`.
 */
export interface AttachmentTarget {
  /** The record's permission subject: `Note`. */
  readonly subject: string;
  /** False when the record doesn't exist (or is deleted) too: a 404. */
  canRead(principal: Principal, recordId: string): Promise<boolean>;
  canWrite(principal: Principal, recordId: string): Promise<boolean>;
  /**
   * Whether the principal may read every one of these fields of the record
   * (field-level permissions): for a generated file that shows them (an
   * issued document). Without it, such files are nobody's to download.
   */
  canReadFields?(
    principal: Principal,
    recordId: string,
    fields: readonly string[],
  ): Promise<boolean>;
  /**
   * The record's table and its id column: the nightly sweep removes the
   * attachments whose record has no row there (deleted for good; one in a
   * recycle bin still has its row), file and row.
   */
  readonly records: { readonly table: PgTable; readonly id: AnyPgColumn };
}

@Injectable()
export class AttachmentsRegistry {
  private readonly targets = new Map<string, AttachmentTarget>();

  register(target: AttachmentTarget) {
    if (this.targets.has(target.subject)) {
      throw new Error(`Two attachment targets are for "${target.subject}".`);
    }
    this.targets.set(target.subject, target);
  }

  get(subject: string) {
    return this.targets.get(subject);
  }

  all() {
    return [...this.targets.values()];
  }
}
