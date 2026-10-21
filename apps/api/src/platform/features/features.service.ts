import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { IamEnv } from '../../iam/iam.env.js';
import { AiProvider } from '../ai/ai-provider.js';
import { PdfRenderer } from '../documents/pdf-renderer.js';
import { switchedOn } from '../switches.js';
import type { Features } from './features.schemas.js';

/**
 * Which switches this deployment has on, for a frontend that hides what is
 * off. Every value is read the way the module it names reads it (the
 * platform switches through `switchedOn()`, the IAM ones through
 * ConfigService, documents through `PdfRenderer.enabled`, the AI helper through
 * `AiProvider.enabled`), so this can't
 * disagree with the routes. Custom code: no @nestjs package reports an
 * app's own switches.
 */
@Injectable()
export class FeaturesService {
  constructor(
    private readonly config: ConfigService<CoreEnv & IamEnv, true>,
    private readonly pdf: PdfRenderer,
    private readonly ai: AiProvider,
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
      magicLink: get('AUTH_MAGIC_LINK'),
      documents: this.pdf.enabled,
      ai: this.ai.enabled,
      tenancy: get('TENANCY'),
      locales: get('LOCALES'),
    };
  }
}
