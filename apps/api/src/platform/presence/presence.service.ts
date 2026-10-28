import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../core/redis/redis.js';
import { tenantKey } from '../../core/tenancy/tenant-scope.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { PeopleService } from '../people/people.service.js';
import { Realtime } from '../realtime/realtime.service.js';
import { SubscriptionsRegistry } from '../subscriptions/subscriptions.registry.js';
import { switchedOn } from '../switches.js';
import {
  MAX_PRESENT,
  PRESENCE_TTL_SECONDS,
  type PresenceMode,
  type PresenceParams,
} from './presence.schemas.js';

/**
 * Who is viewing or editing a record now (docs/presence.md): ephemeral and
 * advisory. Each page beats every few seconds; an entry lives
 * PRESENCE_TTL_SECONDS in Redis (a hash per tenant and record, a field per
 * principal), so a closed tab or a lost connection drops out by itself. Only
 * the mode is kept, never what is being typed. Everything is checked as the
 * caller reading the record (the subject's SubscriptionTarget): whoever may
 * not read it can neither announce themselves on it nor see who is there, and
 * an entry whose person lost access since is left out when listing. Another
 * tab or person hears of a change as a `record.presence` event (ids only) and
 * fetches the list. Saving is still guarded by the record's ETag.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger('Presence');

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly targets: SubscriptionsRegistry,
    private readonly people: PeopleService,
    private readonly realtime: Realtime,
  ) {}

  /** The people on the record now, as the caller (who must read it) sees them. */
  async list(principal: Principal, record: PresenceParams) {
    await this.assertReads(principal, record);
    return this.present(principal, record);
  }

  /** The caller is on the record in this mode: refreshes their entry, returns the list. */
  async beat(principal: Principal, record: PresenceParams, mode: PresenceMode) {
    await this.assertReads(principal, record);
    const self = principalKey(principal);
    if (this.available()) {
      const key = this.key(record);
      const before = await this.redis
        .hget(key, self)
        .then((value) => this.parse(value))
        .catch(() => null);
      const expiresAt = Date.now() + PRESENCE_TTL_SECONDS * 1000;
      try {
        await this.redis
          .multi()
          .hset(key, self, `${mode}:${expiresAt}`)
          .expire(key, PRESENCE_TTL_SECONDS)
          .exec();
      } catch (error) {
        this.logger.warn(`Presence not kept: ${String(error)}`);
      }
      // Others hear of a new arrival or a changed mode, not of every beat.
      if (before?.mode !== mode) {
        await this.announce(record, self);
      }
    }
    return this.present(principal, record);
  }

  /** The caller left the record. */
  async leave(principal: Principal, record: PresenceParams) {
    await this.assertReads(principal, record);
    if (this.available()) {
      try {
        await this.redis.hdel(this.key(record), principalKey(principal));
      } catch (error) {
        this.logger.warn(`Presence not removed: ${String(error)}`);
      }
      await this.announce(record, principalKey(principal));
    }
  }

  private available() {
    return this.redis.status === 'ready';
  }

  private key(record: PresenceParams) {
    return tenantKey(`presence:${record.subject}:${record.recordId}`);
  }

  private parse(value: string | null) {
    if (!value) {
      return null;
    }
    const at = value.indexOf(':');
    const expiresAt = Number(value.slice(at + 1));
    const mode = value.slice(0, at) as PresenceMode;
    return expiresAt > Date.now() ? { mode, expiresAt } : null;
  }

  /** The live entries of a record: principal key -> mode. */
  private async entries(record: PresenceParams) {
    if (!this.available()) {
      return new Map<string, PresenceMode>();
    }
    try {
      const all = await this.redis.hgetall(this.key(record));
      const live = new Map<string, PresenceMode>();
      const expired: string[] = [];
      for (const [key, value] of Object.entries(all)) {
        const entry = this.parse(value);
        if (entry) {
          live.set(key, entry.mode);
        } else {
          expired.push(key);
        }
      }
      if (expired.length) {
        void this.redis.hdel(this.key(record), ...expired).catch(() => 0);
      }
      return live;
    } catch (error) {
      this.logger.warn(`Presence not read: ${String(error)}`);
      return new Map<string, PresenceMode>();
    }
  }

  /**
   * Whom to show the caller: the live entries of people who may still read
   * the record now (an entry of someone whose access was revoked is left
   * out, and cleaned up) and whom the tenant names.
   */
  private async present(principal: Principal, record: PresenceParams) {
    const self = principalKey(principal);
    const live = await this.readers(record);
    const names = await this.people.names([...live.keys()]);
    return {
      items: [...live]
        .flatMap(([key, mode]) => {
          const name = names.get(key);
          return name ? [{ key, name, mode, self: key === self }] : [];
        })
        .slice(0, MAX_PRESENT),
    };
  }

  /** The live entries of those who may read the record, dropping (and deleting) the others. */
  private async readers(record: PresenceParams) {
    const live = await this.entries(record);
    const readers = new Map<string, PresenceMode>();
    const revoked: string[] = [];
    await Promise.all(
      [...live].slice(0, MAX_PRESENT * 2).map(async ([key, mode]) => {
        const person = await this.people.principal(key).catch(() => null);
        if (person && (await this.canRead(person, record))) {
          readers.set(key, mode);
        } else {
          revoked.push(key);
        }
      }),
    );
    if (revoked.length && this.available()) {
      void this.redis.hdel(this.key(record), ...revoked).catch(() => 0);
    }
    return readers;
  }

  /** Tells the people on the record (and the one who changed, for their other tabs) to fetch the list. */
  private async announce(record: PresenceParams, changed: string) {
    if (!switchedOn('REALTIME')) {
      return;
    }
    try {
      const keys = new Set([...(await this.readers(record)).keys(), changed]);
      for (const key of keys) {
        const person = await this.people.principal(key);
        if (person && (await this.canRead(person, record))) {
          this.realtime.toPrincipal(person, 'record.presence', {
            subject: record.subject,
            recordId: record.recordId,
          });
        }
      }
    } catch (error) {
      this.logger.warn(`Presence not announced: ${String(error)}`);
    }
  }

  private async canRead(principal: Principal, record: PresenceParams) {
    try {
      await this.assertReads(principal, record);
      return true;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        return false;
      }
      throw error;
    }
  }

  /** A 404 unless the principal reads the record (a subject without a SubscriptionTarget has no presence). */
  private async assertReads(principal: Principal, record: PresenceParams) {
    const target = this.targets.find(record.subject);
    if (!target) {
      throw new NotFoundException(`No records of ${record.subject}.`);
    }
    await target.assertCanWatch(principal, record.recordId);
  }
}
