import { randomInt } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Transaction } from '../../core/database/drizzle.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import type { IamEnv } from '../iam.env.js';
import { slugOf } from './access.seeder.js';
import { SingleTenant } from './single-tenant.js';
import { TenantsService } from './tenants.service.js';

/** The random part of a sign-up tenant's slug: 36^6 (about 2·10⁹) handles per name. */
const SUFFIX = 6;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** A drawn slug taken already (a 1 in 10⁹ chance): drawn again, this many times in all. */
const ATTEMPTS = 3;

/**
 * TENANT_SIGN_UP (docs/tenancy.md, "Tenants made at sign-up"): with
 * TENANCY=multi and AUTH_SIGN_UP=on, a self sign-up (`POST /v1/auth/sign-up`,
 * or a first sign-in with a provider) makes a new tenant, its roles, and the
 * new account as its first administrator, in one transaction run in the new
 * tenant's scope (TenantsService.create(), as the operators' route does): a
 * refused account (its address taken meanwhile) leaves no tenant behind.
 * Off (the default), or with TENANCY=single, sign-ups go on as before
 * (SingleTenant.newAccount(): in no tenant, or into the one tenant).
 *
 * The slug is drawn here, never chosen: the tenant's name and a random
 * suffix (`acme-k3x9q2`), so a sign-up can't learn which handles exist (no
 * 409 to probe them with), nor squat one; operators may rename it
 * (`PATCH /v1/tenants/{id}`). Configuration, not a NestJS feature: nothing in
 * @nestjs/* decides who makes a tenant.
 */
@Injectable()
export class SignUpTenant implements OnApplicationBootstrap {
  private readonly logger = new Logger('Tenancy');

  constructor(
    private readonly config: ConfigService<IamEnv, true>,
    private readonly singleTenant: SingleTenant,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
  ) {}

  private get requested(): boolean {
    return this.config.get('TENANT_SIGN_UP', { infer: true });
  }

  /** Whether a self sign-up makes its own tenant here. */
  get enabled(): boolean {
    return (
      this.requested &&
      !this.singleTenant.enabled &&
      this.config.get('AUTH_SIGN_UP', { infer: true })
    );
  }

  /** TENANT_SIGN_UP checked at start: what it can't do is said, never silent. */
  onApplicationBootstrap() {
    if (!this.requested) {
      return;
    }
    if (this.singleTenant.enabled) {
      this.logger.warn(
        'TENANT_SIGN_UP is ignored with TENANCY=single: sign-ups join the one tenant.',
      );
      return;
    }
    if (!this.config.get('AUTH_SIGN_UP', { infer: true })) {
      this.logger.warn(
        'TENANT_SIGN_UP is ignored with AUTH_SIGN_UP=off: nobody signs up.',
      );
      return;
    }
    if (this.config.get('CAPTCHA_MODE', { infer: true }) === 'off') {
      this.logger.warn(
        'TENANT_SIGN_UP=on with CAPTCHA_MODE=off: every sign-up makes a tenant, and only the rate limit stands in the way of a bot (docs/auth.md, "Bot protection").',
      );
    }
  }

  /**
   * Makes a self sign-up's account with `create`, in one transaction: in a
   * new tenant named `tenantName`, with the account as its administrator,
   * when TENANT_SIGN_UP applies; otherwise as SingleTenant.newAccount() does.
   */
  async newAccount<T extends UserPrincipal>(
    create: (tx: Transaction) => Promise<T>,
    { tenantName, ip }: { tenantName: string; ip?: string },
  ): Promise<T> {
    if (!this.enabled) {
      return this.singleTenant.newAccount(create, ip);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const { result } = await this.tenants.create(
          { name: tenantName, slug: drawSlug(tenantName) },
          null,
          async (tx, tenant) => {
            const account = await create(tx);
            await this.tenants.addAdministrator(tx, account.id);
            await this.audit.record(
              { ...account, tenantId: tenant.id },
              {
                action: 'tenant.created',
                targetType: 'tenant',
                targetId: tenant.id,
                details: { slug: tenant.slug, via: 'sign-up' },
                ip,
              },
              tx,
            );
            return account;
          },
        );
        return result!;
      } catch (error) {
        if (attempt < ATTEMPTS && isSlugTaken(error)) {
          continue;
        }
        throw error;
      }
    }
  }
}

/** `acme-corp-k3x9q2`: the name's slug (shortened to fit 48) and a random suffix. */
export function drawSlug(name: string): string {
  const base = slugOf(name)
    .slice(0, 48 - SUFFIX - 1)
    .replace(/-+$/, '');
  let suffix = '';
  for (let i = 0; i < SUFFIX; i++) {
    suffix += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${base || 'tenant'}-${suffix}`;
}

function isSlugTaken(error: unknown): boolean {
  if (!(error instanceof ConflictException)) {
    return false;
  }
  const body = error.getResponse();
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'tenant_slug_taken'
  );
}
