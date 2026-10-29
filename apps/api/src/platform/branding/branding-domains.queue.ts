import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';

/**
 * The custom domains' DNS checks (docs/branding.md, "Custom domains"): a
 * lookup out of the deployment on a tenant's word, so on the workers,
 * never in a request. Run by BrandingDomainsProcessor in the job's tenant.
 */
export const CUSTOM_DOMAINS = 'custom-domains';

/** Look a custom domain's TXT record up. */
export interface CustomDomainJob extends TenantEnvelope {
  kind: 'domain-verification';
  domainId: string;
}

/** A DNS TXT lookup: the records, each as its strings (`dns.promises.resolveTxt`). */
export interface TxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

/** The resolver the checks use: the system's, or a test's. */
export const CUSTOM_DOMAINS_TXT_RESOLVER = Symbol(
  'CUSTOM_DOMAINS_TXT_RESOLVER',
);
