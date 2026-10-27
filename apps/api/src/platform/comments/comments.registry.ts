import { Injectable } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * A feature whose records take comments. Register from the constructor:
 * `comments.register(this)`. The platform asks it who may read a record
 * (and so read and write its comments, and be mentioned in them) and who
 * may moderate them (remove anyone's).
 *
 * ```ts
 * readonly subject = 'Note';
 * async canRead(principal, id) { const note = await this.find(id, principal); return note !== null && this.policy.read(principal, note); }
 * async canModerate(principal, id) { … this.policy.update(principal, note) }
 * link(id) { return `/notes/${id}`; }
 * async title(id) { return (await this.notes.findOne(id)).title; }
 * ```
 */
export interface CommentTarget {
  /** The records' permission subject: `Note`. */
  readonly subject: string;
  /**
   * The notification type the record's watchers get for a new comment
   * (declared by the feature, `data`: recordId, commentId, title, by,
   * excerpt). Default: the subject in lower case, `.commented`.
   */
  readonly commentedType?: string;
  /** Whether the principal may read the record: false when it doesn't exist too (one 404 for both). */
  canRead(principal: Principal, recordId: string): Promise<boolean>;
  /** Whether the principal may remove anyone's comment on the record. */
  canModerate(principal: Principal, recordId: string): Promise<boolean>;
  /** The record in the web app: a path, for notifications. */
  link(recordId: string): string;
  /** What the record is called, for notifications' texts. */
  title(recordId: string): Promise<string>;
}

@Injectable()
export class CommentsRegistry {
  private readonly targets = new Map<string, CommentTarget>();

  register(target: CommentTarget) {
    if (this.targets.has(target.subject)) {
      throw new Error(`Two comment targets are for "${target.subject}".`);
    }
    this.targets.set(target.subject, target);
  }

  /** The registered target of a subject; an error when none is (a programming mistake). */
  get(subject: string): CommentTarget {
    const target = this.targets.get(subject);
    if (!target) {
      throw new Error(
        `"${subject}" takes no comments: register a CommentTarget for it.`,
      );
    }
    return target;
  }
}
