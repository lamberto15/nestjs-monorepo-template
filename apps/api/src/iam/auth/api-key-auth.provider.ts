import { type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ApiKeyProvider, AuthenticationRegistry } from '@nestjs/authentication';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Database } from '../../core/database/drizzle.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
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
    private readonly tenancy: Tenancy,
    registry: AuthenticationRegistry,
  ) {
    super({ prefix: API_KEY_PREFIX, realm: 'api' });
    registry.registerProvider(this, { order: 1 });
  }

  // The key (a global table) names its tenant; the client, a tenant table,
  // is read in that tenant's scope (docs/tenancy.md). A key of an inactive
  // tenant stops.
  async findKey(id: string) {
    const [key] = await this.db
      .select({ key: apiKeys, tenantActive: tenants.active })
      .from(apiKeys)
      .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
      .where(eq(apiKeys.keyId, id));
    const now = new Date();
    if (
      !key?.tenantActive ||
      key.key.revokedAt ||
      (key.key.expiresAt && key.key.expiresAt <= now)
    ) {
      return null;
    }
    const [client] = await this.tenancy.run(key.key.tenantId, () =>
      this.db
        .select()
        .from(apiClients)
        .where(eq(apiClients.id, key.key.clientId)),
    );
    if (!client?.active) {
      return null;
    }
    return {
      hash: key.key.keyHash,
      user: {
        kind: 'client' as const,
        id: client.id,
        name: client.name,
        dailyQuota: client.dailyQuota,
        tenantId: client.tenantId,
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
