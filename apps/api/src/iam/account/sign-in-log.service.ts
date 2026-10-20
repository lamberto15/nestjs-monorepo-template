import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SIGN_IN_ACTIONS } from '../audit/sign-in-actions.js';
import { AuditService } from '../audit/audit.service.js';
import { type UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';

/**
 * A tenant's own record of its members' sign-ins (docs/auth.md, "Sign-in
 * log"). The account-level entries (`auth.signed-in`) belong to the person
 * and stay in no tenant (docs/tenancy.md); this one is a second entry in the
 * tenant the sign-in lands in (the token's, else the last chosen), which is
 * all that tenant's administrators ever read of it: no other tenant's
 * sign-ins, and none of an unknown address.
 */
@Injectable()
export class SignInLog implements OnApplicationShutdown {
  private readonly logger = new Logger(SignInLog.name);
  /** Failed sign-ins being written (see `failed`). */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly audit: AuditService,
    private readonly users: UsersRepository,
    private readonly tenancy: Tenancy,
  ) {}

  /** A sign-in of `user`, by `method`; `details` as the account-level entry's. */
  succeeded(
    user: UserPrincipal,
    entry: {
      method: string;
      ip: string;
      tenantId?: string | null;
      details?: Record<string, unknown>;
    },
  ) {
    return this.record(user, SIGN_IN_ACTIONS.succeeded, entry);
  }

  /**
   * A refused sign-in to the account of `user` (a wrong password). Written
   * after the answer is decided and not waited for: an unknown address has
   * nobody's log to write, and the two must take the same time (the decoy
   * hash of CredentialsService). A failure to write is logged only.
   */
  failed(
    user: UserPrincipal,
    entry: { method: string; ip?: string; details?: Record<string, unknown> },
  ) {
    const work = this.record(user, SIGN_IN_ACTIONS.failed, {
      ...entry,
      ip: entry.ip ?? '',
    })
      .catch((error: unknown) =>
        this.logger.warn(`A failed sign-in was not logged: ${String(error)}`),
      )
      .finally(() => this.inFlight.delete(work));
    this.inFlight.add(work);
  }

  /** The writes of failed sign-ins, once done (tests, shutdown). */
  async settled() {
    await Promise.allSettled(this.inFlight);
  }

  async onApplicationShutdown() {
    await this.settled();
  }

  private async record(
    user: UserPrincipal,
    action: string,
    entry: {
      method: string;
      ip: string;
      tenantId?: string | null;
      details?: Record<string, unknown>;
    },
  ) {
    const tenantId =
      entry.tenantId === undefined
        ? await this.users.defaultTenant(user.id)
        : entry.tenantId;
    if (!tenantId) {
      return; // a member of no tenant: nobody's log
    }
    await this.tenancy.run(tenantId, () =>
      this.audit.record(user, {
        action,
        targetType: 'user',
        targetId: user.id,
        ip: entry.ip || undefined,
        details: { ...entry.details, method: entry.method },
      }),
    );
  }
}
