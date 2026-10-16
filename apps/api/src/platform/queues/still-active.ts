import { eq } from 'drizzle-orm';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import type { UsersRepository } from '../../iam/auth/users.repository.js';
import { apiClients } from '../../iam/iam.tables.js';

/**
 * The principal a queued job acts for, as it is now, or null when it was
 * deactivated since the job was queued: a job checks it again before it
 * does anything in their name.
 */
export async function stillActive(
  principal: RequestPrincipal,
  users: UsersRepository,
  db: Database | Transaction,
): Promise<RequestPrincipal | null> {
  if (principal.kind === 'user') {
    const user = await users.findActive(principal.id);
    // Started while impersonating: the audit keeps who really did it.
    return user && principal.impersonator
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
  return client?.active ? principal : null;
}
