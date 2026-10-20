import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { SignInPasswordCheck } from './sign-in-password-check.js';

/** Passwords: checked the same way for a session (sign-in) and for tokens (POST /auth/token). */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly accounts: UsersRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly audit: AuditService,
    private readonly breachCheck: SignInPasswordCheck,
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
    // Verify first (docs/auth.md, "Sign-up"): a password set before its
    // address was proved (a self sign-up) signs nobody in, by session or
    // token, until the address is: else whoever signed up someone else's
    // address would sign in as them. Told only to whoever knows the
    // password. Custom: @nestjs/authentication's `verifiedEmail` guards
    // routes for a signed-in user, not the password check that signs in.
    if (!found.user.emailVerified) {
      throw new ForbiddenException({
        code: 'email_unverified',
        message: t('auth.emailUnverified'),
      });
    }
    // The cost settings changed since this hash was stored: upgrade it while we have the plaintext.
    let passwordHash = found.passwordHash;
    if (this.passwordHasher.needsRehash(passwordHash)) {
      passwordHash = await this.passwordHasher.hash(password);
      await this.accounts.updatePasswordHash(found.user.id, passwordHash);
    }
    // The password is right: is it in a breach? Started, not awaited
    // (docs/auth.md, "Passwords"): the sign-in never waits on it.
    this.breachCheck.start(found.user, password, passwordHash, ip ?? '');
    return found.user;
  }
}
