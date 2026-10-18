import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { PeopleService } from '../people/people.service.js';
import type { RecordRef } from '../subscriptions/subscriptions.service.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { switchedOn } from '../switches.js';
import { Realtime } from './realtime.service.js';

/** The realtime events of a record's activity (docs/webhooks-and-realtime.md, "Record events"). */
export const RECORD_EVENTS = {
  /** A comment added, edited or removed: `{ subject, recordId, commentId, action }`. */
  commented: 'record.commented',
  /** An attachment added or removed: `{ subject, recordId, attachmentId, action }`. */
  attachmentsChanged: 'record.attachments.changed',
} as const;

/** Watchers checked at once: each is a permission check (a few queries). */
const BATCH = 10;

/**
 * Tells a record's open pages that something on it changed (a comment, an
 * attachment), so they reload that panel instead of polling. To the
 * record's watchers and the one who made the change (their other tabs),
 * each in their room of the current tenant (Realtime.toPrincipal), and
 * only those who may read the record now (`canRead`, the feature's own
 * answer, asked as each of them): a watcher who lost access hears
 * nothing. The event carries ids only, never the content: the page
 * fetches it with its own permissions.
 *
 * After the commit, as every push; REALTIME=off does nothing (not even
 * the checks). A failure is logged, never the request's: the change is
 * committed. Shutdown waits for the pushes under way (before the gateway
 * and its Redis adapter close), so none publishes on a closed connection.
 * Custom code: the gateway has rooms per principal, not per
 * record (Realtime), and @nestjs/websockets knows nothing of permissions.
 */
@Injectable()
export class RecordActivity
  implements OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly logger = new Logger('RecordActivity');
  /** The pushes under way: shutdown waits for them. */
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly realtime: Realtime,
    private readonly subscriptions: SubscriptionsService,
    private readonly people: PeopleService,
  ) {}

  /** Sends the event; callers don't await it (the answer doesn't wait for the checks). */
  push(
    record: RecordRef,
    event: (typeof RECORD_EVENTS)[keyof typeof RECORD_EVENTS],
    data: Record<string, unknown>,
    options: {
      by: Principal;
      canRead: (principal: Principal) => Promise<boolean>;
    },
  ): Promise<void> {
    if (!switchedOn('REALTIME')) {
      return Promise.resolve();
    }
    const sent = this.send(record, event, data, options).finally(() =>
      this.pending.delete(sent),
    );
    this.pending.add(sent);
    return sent;
  }

  /** As early as shutdown can (the database pool may close in another module's hook). */
  async onModuleDestroy() {
    await Promise.allSettled(this.pending);
  }

  /** And again before the gateway and its Redis adapter close. */
  async beforeApplicationShutdown() {
    await Promise.allSettled(this.pending);
  }

  private async send(
    record: RecordRef,
    event: (typeof RECORD_EVENTS)[keyof typeof RECORD_EVENTS],
    data: Record<string, unknown>,
    {
      by,
      canRead,
    }: {
      by: Principal;
      canRead: (principal: Principal) => Promise<boolean>;
    },
  ) {
    try {
      const keys = new Set(await this.subscriptions.watchers(record));
      if (by.kind !== 'system') {
        keys.add(principalKey(by));
      }
      const payload = {
        ...data,
        subject: record.subject,
        recordId: record.recordId,
      };
      const all = [...keys];
      for (let at = 0; at < all.length; at += BATCH) {
        await Promise.all(
          all.slice(at, at + BATCH).map(async (key) => {
            const principal = await this.people.principal(key);
            if (principal && (await canRead(principal).catch(() => false))) {
              this.realtime.toPrincipal(principal, event, payload);
            }
          }),
        );
      }
    } catch (error) {
      this.logger.warn(`${event} was not pushed`, {
        subject: record.subject,
        recordId: record.recordId,
        error: String(error),
      });
    }
  }
}
