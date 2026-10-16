import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';

/** Passwords: checked the same way for a session (sign-in) and for tokens (POST /auth/token). */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly accounts: UsersRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly audit: AuditService,
  ) {}

  /**
   * Whether `password` is the account's current one. Nothing is audited and
   * nothing thrown: the caller says what the check was for (a deletion).
   * No account, or none with a password: false, in the same time.
   */
  async matches(email: string, password: string) {
    const found = await this.accounts.findActiveByEmail(email);
    const valid = await this.passwordHasher.verify(
      password,
      found?.passwordHash ?? undefined,
    );
    return valid && !!found?.passwordHash;
  }

  /**
   * The user, or a 401, audited. With no account (or no password), verify()
   * checks a dummy hash: an unknown email and a wrong password take the same
   * time and get the same answer.
   */
  async verify(email: string, password: string, ip?: string) {
    const found = await this.accounts.findActiveByEmail(email);
    const valid = await this.passwordHasher.verify(
      password,
      found?.passwordHash ?? undefined,
    );
    if (!valid || !found?.passwordHash) {
      await this.audit.recordAnonymous(email, {
        action: 'auth.sign-in-failed',
        ip,
      });
      throw new UnauthorizedException(t('auth.invalidCredentials'));
    }
    // The cost settings changed since this hash was stored: upgrade it while we have the plaintext.
    if (this.passwordHasher.needsRehash(found.passwordHash)) {
      await this.accounts.updatePasswordHash(
        found.user.id,
        await this.passwordHasher.hash(password),
      );
    }
    return found.user;
  }
}
