import { Injectable } from '@nestjs/common';
import {
  AuthenticationRegistry,
  SessionCookieProvider,
  type SessionRecord,
} from '@nestjs/authentication';
import type { Principal } from './principal.js';
import { impersonationOf, sessionTenant } from './impersonation.js';
import { UsersRepository } from './users.repository.js';

/** Users, signed in with the session cookie. */
@Injectable()
export class SessionAuth extends SessionCookieProvider<Principal> {
  constructor(
    private readonly accounts: UsersRepository,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerProvider(this);
  }

  // Every request: a deactivated or deleted account loses access at once, a
  // membership that ended takes the session's tenant away (docs/tenancy.md),
  // and an impersonation ends when its time is up or its administrator
  // loses access to the account or to the tenant it was started in.
  async validate(session: SessionRecord) {
    const user = await this.accounts.inTenant(
      session.userId,
      sessionTenant(session),
    );
    const impersonation = impersonationOf(session);
    if (!user || !impersonation) {
      return user;
    }
    if (Date.now() >= Date.parse(impersonation.endsAt)) {
      return null;
    }
    // Never across tenants: the impersonation lives in the tenant it began
    // in, while both are members of it.
    if (!user.tenantId || user.tenantId !== impersonation.tenantId) {
      return null;
    }
    const impersonator = await this.accounts.inTenant(
      impersonation.id,
      impersonation.tenantId,
    );
    return impersonator?.tenantId === impersonation.tenantId
      ? {
          ...user,
          impersonator: { id: impersonator.id, email: impersonator.email },
        }
      : null;
  }
}
