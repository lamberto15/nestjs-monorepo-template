import { eq } from 'drizzle-orm';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import { currentTenantId } from '../../core/tenancy/tenant-scope.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import type { UsersRepository } from '../../iam/auth/users.repository.js';
import { apiClients } from '../../iam/iam.tables.js';

/**
 * The principal a queued job acts for, as it is now, or null when it was
 * deactivated since the job was queued, or no longer acts in the job's
 * tenant: a job checks it again before it does anything in their name.
 *
 * Called inside the job's tenant (TenantWorkerHost restored it from the
 * envelope): the principal must have queued it in that very tenant, a user
 * must still be an active member of it (docs/tenancy.md), and an API client
 * is looked up there (row-level security: another tenant's client is none).
 */
export async function stillActive(
  principal: RequestPrincipal,
  users: UsersRepository,
  db: Database | Transaction,
  /**
   * `account`: a job of the account itself, in no tenant (a person's data
   * export): the user's account must be active, whatever tenant they act in.
   */
  { account = false }: { account?: boolean } = {},
): Promise<RequestPrincipal | null> {
  if (account) {
    if (principal.kind !== 'user' || principal.impersonator) {
      return null;
    }
    return users.findActive(principal.id);
  }
  const tenantId = currentTenantId();
  if (!tenantId || principal.tenantId !== tenantId) {
    return null; // a payload whose principal acted elsewhere: never run
  }
  if (principal.kind === 'user') {
    const user = await users.inTenant(principal.id, tenantId);
    if (!user || user.tenantId !== tenantId) {
      return null;
    }
    // Started while impersonating: the audit keeps who really did it.
    return principal.impersonator
      ? { ...user, impersonator: principal.impersonator }
      : user;
  }
  if (principal.kind !== 'client') {
    return null; // a payload is data: never the system principal (docs/permissions.md)
  }
  const [client] = await db
    .select()
    .from(apiClients)
    .where(eq(apiClients.id, principal.id));
  return client?.active && client.tenantId === tenantId
    ? {
        ...principal,
        name: client.name,
        dailyQuota: client.dailyQuota,
        tenantId,
      }
    : null;
}
