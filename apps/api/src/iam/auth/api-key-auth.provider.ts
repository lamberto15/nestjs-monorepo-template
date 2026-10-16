import { type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ApiKeyProvider, AuthenticationRegistry } from '@nestjs/authentication';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Database } from '../../core/database/drizzle.js';
import { apiClients, apiKeys } from '../iam.tables.js';
import { API_KEY_PREFIX } from './api-keys.js';
import type { Principal } from './principal.js';

/** How often a key's last use is written: at most once a minute per key. */
const LAST_USED_EVERY_MS = 60_000;

/**
 * API clients: `Authorization: Bearer <prefix>_<id>_<secret>`. The package
 * compares the key's SHA-256 with the stored one in constant time. A key
 * works while it isn't revoked or expired and its client is active: a
 * revoked key or client stops on its next request.
 */
@Injectable()
export class ApiKeyAuth extends ApiKeyProvider<Principal> {
  private readonly logger = new Logger('ApiKeys');

  constructor(
    @InjectDrizzle() private readonly db: Database,
    registry: AuthenticationRegistry,
  ) {
    super({ prefix: API_KEY_PREFIX, realm: 'api' });
    registry.registerProvider(this, { order: 1 });
  }

  async findKey(id: string) {
    const [found] = await this.db
      .select({ key: apiKeys, client: apiClients })
      .from(apiKeys)
      .innerJoin(apiClients, eq(apiClients.id, apiKeys.clientId))
      .where(eq(apiKeys.keyId, id));
    const now = new Date();
    if (
      !found?.client.active ||
      found.key.revokedAt ||
      (found.key.expiresAt && found.key.expiresAt <= now)
    ) {
      return null;
    }
    return {
      hash: found.key.keyHash,
      user: {
        kind: 'client' as const,
        id: found.client.id,
        name: found.client.name,
        dailyQuota: found.client.dailyQuota,
      },
    };
  }

  /** After the package verified the secret: record the use (findKey runs before that). */
  override async authenticate(context: ExecutionContext) {
    const result = await super.authenticate(context);
    if (result?.session?.keyId) {
      this.touch(result.session.keyId, new Date());
    }
    return result;
  }

  /** Records the use, without making the request wait for it. */
  private touch(keyId: string, now: Date) {
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiKeys.keyId, keyId),
          or(
            isNull(apiKeys.lastUsedAt),
            lt(
              apiKeys.lastUsedAt,
              new Date(now.getTime() - LAST_USED_EVERY_MS),
            ),
          ),
        ),
      )
      .catch((error: Error) =>
        this.logger.warn(`Last use not recorded: ${error.message}`),
      );
  }
}
