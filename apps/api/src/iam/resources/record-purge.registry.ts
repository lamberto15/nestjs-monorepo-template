import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../core/database/drizzle.js';

/**
 * What else goes when records are deleted for good: the platform's data
 * about them (comments, tags, watchers, revisions), kept in tables of
 * their own without a foreign key to the record. SoftDeletePurgeJob calls
 * every listener in the purge's transaction, before deleting the rows.
 * Register from the constructor: `purges.register(this)`.
 */
export interface RecordPurgeListener {
  /** For the logs and the uniqueness check: `comments`. */
  readonly name: string;
  /** Only the records of this subject; every subject when left out. */
  readonly subject?: string;
  /** Removes what refers to these records of `subject` (a batch). */
  forget(tx: Transaction, subject: string, recordIds: string[]): Promise<void>;
}

@Injectable()
export class RecordPurgeRegistry {
  private readonly listeners = new Map<string, RecordPurgeListener>();

  register(listener: RecordPurgeListener) {
    if (this.listeners.has(listener.name)) {
      throw new Error(
        `Two record purge listeners are named "${listener.name}".`,
      );
    }
    this.listeners.set(listener.name, listener);
  }

  /** The listeners for the records of `subject`. */
  of(subject: string) {
    return [...this.listeners.values()].filter(
      (listener) => !listener.subject || listener.subject === subject,
    );
  }
}
