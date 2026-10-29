import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuthenticationRegistry,
  SessionCookieProvider,
  type SessionRecord,
} from '@nestjs/authentication';
import type { Principal } from './principal.js';
import type { IamEnv } from '../iam.env.js';
import { HOST_TENANTS, type HostTenants, hostOf } from './host-tenant.js';
import { impersonationOf, sessionTenant } from './impersonation.js';
import { SessionLifetime } from './session-lifetime.js';
import { UsersRepository } from './users.repository.js';

/** Users, signed in with the session cookie. */
@Injectable()
export class SessionAuth extends SessionCookieProvider<Principal> {
  /** The tenant of the request's custom domain, while its session is validated. */
  private readonly hostTenant = new AsyncLocalStorage<string>();

  constructor(
    private readonly accounts: UsersRepository,
    private readonly config: ConfigService<IamEnv, true>,
    private readonly lifetime: SessionLifetime,
    registry: AuthenticationRegistry,
    @Optional()
    @Inject(HOST_TENANTS)
    private readonly hosts?: HostTenants,
  ) {
    super();
    registry.registerProvider(this);
  }

  // A tenant's custom domain is that tenant's only (docs/branding.md,
  // "Custom domains"): on it, a session acts in that tenant when its user
  // is a member, else in none, whatever tenant it was switched to. The
  // cookie is host-only, so a session there was signed in there; the host
  // only ever narrows what a membership already allows.
  override async authenticate(context: ExecutionContext) {
    const host = hostOf(context);
    const tenantId = host ? await this.hosts?.tenantOfHost(host) : null;
    return tenantId
      ? this.hostTenant.run(tenantId, () => super.authenticate(context))
      : super.authenticate(context);
  }

  // Every request: a deactivated or deleted account loses access at once, a
  // membership that ended takes the session's tenant away (docs/tenancy.md),
  // and an impersonation ends when its time is up or its administrator
  // loses access to the account or to the tenant it was started in.
  async validate(session: SessionRecord) {
    const pinned = this.hostTenant.getStore();
    const user = pinned
      ? ((await this.accounts.inTenant(session.userId, pinned)) ??
        (await this.accounts.inTenant(session.userId, null)))
      : await this.accounts.inTenant(session.userId, sessionTenant(session));
    const impersonation = impersonationOf(session);
    if (!user) {
      return user;
    }
    // The tenant's session limits (auth.sessionIdleMinutes, auth.sessionMaxHours),
    // under the environment's, which the package applied already. Not for
    // an impersonation: it has its own time (below) and ends with the
    // administrator's say.
    if (
      !impersonation &&
      (await this.lifetime.expired(session, user.tenantId))
    ) {
      return null;
    }
    if (!impersonation) {
      return user;
    }
    // IMPERSONATION=off ends the running ones too.
    if (!this.config.get('IMPERSONATION', { infer: true })) {
      return null;
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
