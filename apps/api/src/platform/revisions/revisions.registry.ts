import { Injectable } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * A kind of record whose revisions are kept. The feature calls
 * `RevisionsService.record(tx, …)` in its create and update transactions
 * and registers this from the constructor: `revisions.register(this)`.
 *
 * ```ts
 * readonly subject = 'Note';
 * async canRead(principal, id) { … this.policy.read(principal, note) }     // false when missing: 404
 * async canRestore(principal, id) { … this.policy.update(principal, note) }
 * snapshot(note) { return { title: note.title, body: note.body, custom: note.custom }; }
 * async apply(principal, id, fields, { ip, restoredFrom }) { … this.notes.update(…) … }
 * async shown(principal, id) { … the record as GET /v1/notes/{id} answers it }
 * async redact(principal, id, items) { … hide the fields the reader may not see }
 * ```
 */
export interface RevisionTarget {
  /** The records' permission subject: `Note`. */
  readonly subject: string;
  /** Whether the principal may read the record (and its revisions); false when it doesn't exist: a 404. */
  canRead(principal: Principal, recordId: string): Promise<boolean>;
  /** Whether the principal may restore a revision (change the record). */
  canRestore(principal: Principal, recordId: string): Promise<boolean>;
  /** The record's changeable fields, as a revision keeps them (JSON values). */
  snapshot(record: object): Record<string, unknown>;
  /**
   * Sets the record's fields to `fields` (a snapshot) through the feature's
   * own update (its checks, audit entry, and revision, passing
   * `restoredFrom` on), and answers the record as its GET does.
   */
  apply(
    principal: Principal,
    recordId: string,
    fields: Record<string, unknown>,
    options: {
      ip?: string;
      restoredFrom: number;
      unchanged?: (current: object) => void;
    },
  ): Promise<object>;
  /** The record as its GET answers it to the principal (what its ETag covers). */
  shown(principal: Principal, recordId: string): Promise<object>;
  /**
   * The revisions' snapshots and changes without what the principal may
   * not read (field-level permissions; custom fields deactivated since),
   * in the same order. Default: all of it.
   */
  redact?(
    principal: Principal,
    recordId: string,
    items: RevisionItem[],
  ): Promise<RevisionItem[]>;
}

/** What a revision shows of a record: its fields, and what changed (`custom.<key>` per custom value). */
export interface RevisionItem {
  snapshot: Record<string, unknown>;
  changes: Record<string, { from: unknown; to: unknown }> | null;
}

@Injectable()
export class RevisionsRegistry {
  private readonly targets = new Map<string, RevisionTarget>();

  register(target: RevisionTarget) {
    if (this.targets.has(target.subject)) {
      throw new Error(`Two revision targets are for "${target.subject}".`);
    }
    this.targets.set(target.subject, target);
  }

  /** The registered target of a subject; an error when none is (a programming mistake). */
  get(subject: string): RevisionTarget {
    const target = this.targets.get(subject);
    if (!target) {
      throw new Error(
        `"${subject}" keeps no revisions: register a RevisionTarget for it.`,
      );
    }
    return target;
  }
}
