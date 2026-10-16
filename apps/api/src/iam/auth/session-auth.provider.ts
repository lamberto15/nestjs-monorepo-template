import { Injectable } from '@nestjs/common';
import {
  AuthenticationRegistry,
  SessionCookieProvider,
  type SessionRecord,
} from '@nestjs/authentication';
import type { Principal } from './principal.js';
import { impersonationOf } from './impersonation.js';
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

  // Every request: a deactivated or deleted account loses access at once, and
  // an impersonation ends when its time is up or its administrator loses access.
  async validate(session: SessionRecord) {
    const user = await this.accounts.findActive(session.userId);
    const impersonation = impersonationOf(session);
    if (!user || !impersonation) {
      return user;
    }
    if (Date.now() >= Date.parse(impersonation.endsAt)) {
      return null;
    }
    const impersonator = await this.accounts.findActive(impersonation.id);
    return impersonator
      ? {
          ...user,
          impersonator: { id: impersonator.id, email: impersonator.email },
        }
      : null;
  }
}
