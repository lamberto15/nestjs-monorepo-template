import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { SystemContext } from '../../iam/access/system-context.js';
import { CUSTOM_DOMAINS_JOB } from '../platform.jobs.js';
import { BrandingDomainsService } from './branding-domains.service.js';

/**
 * Every night at 02:15 in APP_TIMEZONE, on one instance: looks the TXT
 * record of every verified custom domain up again, in its tenant. A
 * record gone (the domain changed hands, the tenant took it down) ends the
 * domain's routing; a lookup that failed changes nothing.
 */
@Injectable()
export class BrandingDomainsJob {
  private readonly logger = new Logger('Branding');

  constructor(
    private readonly system: SystemContext,
    private readonly domains: BrandingDomainsService,
  ) {}

  @Cron('15 2 * * *', {
    name: 'custom-domains',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'branding:custom-domains' })
  @WithoutOverlapping()
  async run() {
    if (!this.domains.enabled) {
      return { checked: 0 };
    }
    let checked = 0;
    const tenantIds = await this.domains.routedTenants();
    for (const tenantId of tenantIds) {
      try {
        await this.system.run(
          CUSTOM_DOMAINS_JOB,
          async (system) => {
            for (const id of await this.domains.verifiedIds()) {
              await this.domains.verify(system, id);
              checked += 1;
            }
          },
          { transaction: false, tenantId },
        );
      } catch (error) {
        // One tenant's failure doesn't stop the others' checks.
        this.logger.error('Custom domain check failed', { tenantId, error });
      }
    }
    this.logger.log('Custom domains checked', { checked });
    return { checked };
  }
}
