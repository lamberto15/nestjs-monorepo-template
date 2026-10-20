import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CoreEnv } from '../../core/config/core.env.js';
import { SignUpTenant } from '../../iam/access/sign-up-tenant.js';
import type { IamEnv } from '../../iam/iam.env.js';
import { PdfRenderer } from '../documents/pdf-renderer.js';
import { switchedOn } from '../switches.js';
import type { Features } from './features.schemas.js';

/**
 * Which switches this deployment has on, for a frontend that hides what is
 * off. Every value is read the way the module it names reads it (the
 * platform switches through `switchedOn()`, the IAM ones through
 * ConfigService, documents through `PdfRenderer.enabled`, a tenant per sign-up through
 * `SignUpTenant.enabled`), so this can't
 * disagree with the routes. Custom code: no @nestjs package reports an
 * app's own switches.
 */
@Injectable()
export class FeaturesService {
  constructor(
    private readonly config: ConfigService<CoreEnv & IamEnv, true>,
    private readonly pdf: PdfRenderer,
    private readonly signUpTenant: SignUpTenant,
  ) {}

  current(): Features {
    const get = <K extends keyof (CoreEnv & IamEnv)>(key: K) =>
      this.config.get(key, { infer: true });
    return {
      realtime: switchedOn('REALTIME'),
      webhooks: switchedOn('WEBHOOKS'),
      reports: switchedOn('REPORTS'),
      usage: switchedOn('USAGE'),
      impersonation: get('IMPERSONATION'),
      mfa: get('AUTH_MFA'),
      apiClients: get('API_CLIENTS'),
      passkeys: get('PASSKEYS'),
      signUp: get('AUTH_SIGN_UP'),
      tenantSignUp: this.signUpTenant.enabled,
      magicLink: get('AUTH_MAGIC_LINK'),
      documents: this.pdf.enabled,
      tenancy: get('TENANCY'),
      locales: get('LOCALES'),
    };
  }
}
