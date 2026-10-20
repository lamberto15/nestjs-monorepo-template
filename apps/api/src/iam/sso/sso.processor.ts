import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { SystemContext } from '../access/system-context.js';
import { SSO_JOB } from '../iam.jobs.js';
import { OidcSso } from './oidc-sso.service.js';
import { SsoConnectionsService } from './sso-connections.service.js';
import { SsoDomainsService } from './sso-domains.service.js';
import { SSO_QUEUE, type SsoJob } from './sso.queue.js';

/**
 * The SSO queue's jobs, on the workers, in the job's tenant, as
 * `system:sso`: what reaches out of the deployment on a tenant's word (its
 * IdP's discovery document, its domain's DNS) never runs in a request.
 */
@Processor(SSO_QUEUE, { concurrency: 2 })
export class SsoProcessor extends TenantWorkerHost<SsoJob> {
  constructor(
    private readonly system: SystemContext,
    private readonly connections: SsoConnectionsService,
    private readonly domains: SsoDomainsService,
    private readonly oidc: OidcSso,
  ) {
    super();
  }

  async handle(job: Job<SsoJob>) {
    await this.run(job.data);
  }

  /** One job's work (the tests run it without a worker). */
  run(data: SsoJob) {
    return this.system.run(
      SSO_JOB,
      async (system) => {
        if (data.kind === 'oidc-discovery') {
          await this.connections.storeDiscovery(
            system,
            data.connectionId,
            (issuer, clientId) => this.oidc.discover(issuer, clientId),
          );
        } else {
          await this.domains.verify(system, data.domainId);
        }
      },
      { transaction: false, tenantId: data.tenantId },
    );
  }
}
