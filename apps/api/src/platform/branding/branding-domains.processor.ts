import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { CUSTOM_DOMAINS_JOB } from '../platform.jobs.js';
import {
  CUSTOM_DOMAINS,
  type CustomDomainJob,
} from './branding-domains.queue.js';
import { BrandingDomainsService } from './branding-domains.service.js';

/**
 * The custom domains' DNS checks, on the workers, in the job's tenant, as
 * `system:custom-domains`: a lookup on a tenant's word never runs in a
 * request.
 */
@Processor(CUSTOM_DOMAINS, { concurrency: 2 })
export class BrandingDomainsProcessor extends TenantWorkerHost<CustomDomainJob> {
  constructor(
    private readonly system: SystemContext,
    private readonly domains: BrandingDomainsService,
  ) {
    super();
  }

  async handle(job: Job<CustomDomainJob>) {
    await this.run(job.data);
  }

  /** One job's work (the tests run it without a worker). */
  run(data: CustomDomainJob) {
    return this.system.run(
      CUSTOM_DOMAINS_JOB,
      (system) => this.domains.verify(system, data.domainId),
      { transaction: false, tenantId: data.tenantId },
    );
  }
}
