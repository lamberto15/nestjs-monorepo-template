import { Injectable } from '@nestjs/common';
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
   * Of these ids, the records that still exist, deleted ones in a recycle
   * bin included (they may come back). The nightly sweep removes the
   * attachments of the others, file and row.
   */
  exists(recordIds: readonly string[]): Promise<string[]>;
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
