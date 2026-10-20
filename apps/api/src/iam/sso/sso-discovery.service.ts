import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, eq } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SsoConnectionsService } from './sso-connections.service.js';
import { emailDomain } from './sso-domains.service.js';
import { ssoConnections, ssoDomainRoutes } from './sso.tables.js';

/** At most this many tenants are looked at for one domain (a domain is rarely shared). */
const MAX_TENANTS = 10;

/**
 * Home-realm discovery: the login URL of an enabled connection of an
 * active tenant that verified the address's domain (`sso_domain_routes`,
 * global, then that tenant's connections in its own scope). Only the
 * domain is read. Several (a domain two tenants verified, a tenant with
 * two connections): the tenant that verified it first, its oldest
 * connection, so the answer is stable.
 */
@Injectable()
export class SsoDiscovery {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly tenancy: Tenancy,
    private readonly connections: SsoConnectionsService,
  ) {}

  async loginUrl(email: string): Promise<string | null> {
    const domain = emailDomain(email.trim());
    if (!domain) {
      return null;
    }
    const routes = await this.tenancy.none(() =>
      database(this.txHost)
        .select({ tenantId: ssoDomainRoutes.tenantId })
        .from(ssoDomainRoutes)
        .where(eq(ssoDomainRoutes.domain, domain))
        .orderBy(asc(ssoDomainRoutes.createdAt), asc(ssoDomainRoutes.tenantId))
        .limit(MAX_TENANTS),
    );
    for (const { tenantId } of routes) {
      const tenant = await this.tenancy.find(tenantId);
      if (!tenant?.active) {
        continue;
      }
      const [connection] = await this.tenancy.run(tenantId, () =>
        database(this.txHost)
          .select({ id: ssoConnections.id, tenantId: ssoConnections.tenantId })
          .from(ssoConnections)
          .where(
            and(
              eq(ssoConnections.tenantId, tenantId),
              eq(ssoConnections.enabled, true),
            ),
          )
          .orderBy(asc(ssoConnections.createdAt), asc(ssoConnections.id))
          .limit(1),
      );
      if (connection) {
        return this.connections.urls(connection).login;
      }
    }
    return null;
  }
}
