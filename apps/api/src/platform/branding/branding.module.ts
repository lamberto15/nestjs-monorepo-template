import { Module } from '@nestjs/common';
import { BrandingService } from './branding.service.js';
import { BrandingLogoUpload } from './branding-logo-upload.interceptor.js';
import { MAIL_BRANDING } from '../../core/mail/mail-branding.js';
import { BrandingDomainsService } from './branding-domains.service.js';
import { BrandingDomainsProcessor } from './branding-domains.processor.js';
import { BrandingDomainsJob } from './branding-domains.job.js';
import { HOST_TENANTS } from '../../iam/auth/host-tenant.js';
import { CUSTOM_DOMAINS_TXT_RESOLVER } from './branding-domains.queue.js';
import { Resolver } from 'node:dns/promises';
import { SettingsModule } from '../settings/settings.module.js';
import {
  BrandingController,
  PublicBrandingController,
} from './branding.controller.js';
import {
  BrandingDomainsController,
  HostBrandingController,
  DomainAskController,
} from './branding-domains.controller.js';

/**
 * The branding capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [SettingsModule],
  controllers: [
    // The tenant's colour, mail sender name and logo (docs/branding.md).
    BrandingController,
    PublicBrandingController,
    // Its custom domains, the brand before sign-in by host, the edge's TLS ask.
    BrandingDomainsController,
    HostBrandingController,
    DomainAskController,
  ],
  providers: [
    // The tenant's name and logo in its mail, asked by the core's mail queue.
    BrandingService,
    BrandingLogoUpload,
    { provide: MAIL_BRANDING, useExisting: BrandingService },
    // Custom domains: the session's tenant on a tenant's own host (SessionAuth).
    BrandingDomainsService,
    BrandingDomainsProcessor,
    BrandingDomainsJob,
    { provide: HOST_TENANTS, useExisting: BrandingDomainsService },
    // The domains' TXT lookups: the system resolver, bounded; the tests replace it.
    {
      provide: CUSTOM_DOMAINS_TXT_RESOLVER,
      useFactory: () => new Resolver({ timeout: 5000, tries: 2 }),
    },
  ],
  exports: [
    BrandingService,
    MAIL_BRANDING,
    BrandingDomainsService,
    HOST_TENANTS,
  ],
})
export class BrandingModule {}
