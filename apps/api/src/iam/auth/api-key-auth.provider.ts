import {
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ApiKeyProvider, AuthenticationRegistry } from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { NodeRequest as Request } from '@nestjs/platform-node';
import type { Redis } from 'ioredis';
import type { Database } from '../../core/database/drizzle.js';
import { REDIS } from '../../core/redis/redis.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import type { IamEnv } from '../iam.env.js';
import { apiClients, apiKeys } from '../iam.tables.js';
import { AuditService } from '../audit/audit.service.js';
import { ipAllowed } from './client-ip.js';
import { API_KEY_PREFIX } from './api-keys.js';
import type { Principal } from './principal.js';

/** How often a key's last use is written: at most once a minute per key. */
const LAST_USED_EVERY_MS = 60_000;

/** A refusal is audited once per client and address in this long. */
const DENIED_AUDIT_EVERY_SECONDS = 3600;

/**
 * API clients: `Authorization: Bearer <prefix>_<id>_<secret>`. The package
 * compares the key's SHA-256 with the stored one in constant time. A key
 * works while it isn't revoked or expired and its client is active: a
 * revoked key or client stops on its next request (a realtime socket opened
 * with it: Realtime, docs/webhooks-and-realtime.md).
 *
 * A client with `allowedCidrs` is served only from those addresses: the
 * address is Express's `req.ip`, so the app's `trust proxy` setting decides
 * which X-Forwarded-For hops count (core/http/http-setup.ts); the header
 * itself is never read here. Otherwise 403 `client_ip_not_allowed`, audited
 * once per address and hour.
 */
@Injectable()
export class ApiKeyAuth extends ApiKeyProvider<Principal> {
  private readonly logger = new Logger('ApiKeys');
  /** The allowlist of the client findKey returned, read back by authenticate (the same object). */
  private readonly allowlists = new WeakMap<object, string[]>();

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly config: ConfigService<IamEnv, true>,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
    registry: AuthenticationRegistry,
  ) {
    super({ prefix: API_KEY_PREFIX, realm: 'api' });
    registry.registerProvider(this, { order: 1 });
  }

  // The key (a global table) names its tenant; the client, a tenant table,
  // is read in that tenant's scope (docs/tenancy.md). A key of an inactive
  // tenant stops.
  async findKey(id: string) {
    // API_CLIENTS=off: no key authenticates.
    if (!this.config.get('API_CLIENTS', { infer: true })) {
      return null;
    }
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
    const user = {
      kind: 'client' as const,
      id: client.id,
      name: client.name,
      dailyQuota: client.dailyQuota,
      tenantId: client.tenantId,
    };
    this.allowlists.set(user, client.allowedCidrs);
    // On the session too (ApiKeySession.expiresAt); Realtime asks findKey
    // again for a key's socket, which ends at it.
    return { hash: key.key.keyHash, user, expiresAt: key.key.expiresAt };
  }

  /** After the package verified the secret: record the use (findKey runs before that). */
  override async authenticate(context: ExecutionContext) {
    const result = await super.authenticate(context);
    if (result?.user) {
      await this.checkAddress(
        context,
        result.user as Principal & { kind: 'client' },
      );
    }
    if (result?.session?.keyId) {
      this.touch(result.session.keyId, new Date());
    }
    return result;
  }

  /** Refuses a request from outside the client's allowlist (after the secret is verified, so a wrong key learns nothing). */
  private async checkAddress(
    context: ExecutionContext,
    client: Principal & { kind: 'client' },
  ) {
    const cidrs = this.allowlists.get(client);
    const ip = context.switchToHttp().getRequest<Request>().ip;
    // A principal findKey didn't return has no known allowlist: refused, never waved through.
    if (cidrs !== undefined && ipAllowed(ip, cidrs)) {
      return;
    }
    await this.auditDenied(client, ip);
    throw new ForbiddenException({
      code: 'client_ip_not_allowed',
      message: 'This API client may not be used from this address.',
    });
  }

  /** One audit entry per client and address an hour (Redis NX), so a flood doesn't fill the log. */
  private async auditDenied(
    client: Principal & { kind: 'client' },
    ip: string | undefined,
  ) {
    try {
      const key = `client-ip-denied:${client.id}:${createHash('sha256')
        .update(ip ?? '')
        .digest('hex')}`;
      const first = await this.redis.set(
        key,
        '1',
        'EX',
        DENIED_AUDIT_EVERY_SECONDS,
        'NX',
      );
      if (first === 'OK') {
        await this.tenancy.run(client.tenantId, () =>
          this.audit.record(client, {
            action: 'client.ip-denied',
            targetType: 'client',
            targetId: client.id,
            details: { name: client.name },
            ip,
          }),
        );
      }
    } catch (error) {
      // The refusal stands even if the audit entry can't be written.
      this.logger.warn(`Refusal not audited: ${(error as Error).message}`);
    }
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
