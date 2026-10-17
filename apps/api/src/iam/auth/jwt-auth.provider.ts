import { Injectable } from '@nestjs/common';
import {
  AuthenticationRegistry,
  JwtBearerProvider,
  type JwtClaims,
} from '@nestjs/authentication';
import type { Principal } from './principal.js';
import { z } from 'zod';
import { UsersRepository } from './users.repository.js';

/** A user's id: anything else (`system:…`, a typo) is no one, not a database error. */
const userId = z.uuid();

/**
 * Users of token clients (mobile apps, CLIs): `Authorization: Bearer <JWT>`
 * from POST /auth/token, verified with the `accessToken` options. The user is
 * loaded on every request, so a deactivated account stops at once.
 */
@Injectable()
export class JwtAuth extends JwtBearerProvider<Principal> {
  constructor(
    private readonly accounts: UsersRepository,
    registry: AuthenticationRegistry,
  ) {
    super({ realm: 'api' });
    // After sessions (0) and API keys (1).
    registry.registerProvider(this, { order: 2 });
  }

  // The tenant is the token's (`tid`, fixed for its refresh family), while
  // the membership in it is active.
  validate({ sub, tid }: JwtClaims) {
    return sub && userId.safeParse(sub).success
      ? this.accounts.inTenant(
          sub,
          typeof tid === 'string' && userId.safeParse(tid).success ? tid : null,
        )
      : null;
  }
}
