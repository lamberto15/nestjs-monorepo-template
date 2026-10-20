import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';

/**
 * The SSO queue (BullMQ): what reaches out of the deployment on a tenant's
 * word, off the request (docs/auth.md, "Enterprise SSO"). Run by SsoProcessor
 * on the workers, as `system:sso`, in the job's tenant.
 */
export const SSO_QUEUE = 'sso';

export type SsoJob =
  /** Fetch an OpenID Connect connection's discovery document (SSRF-guarded). */
  | ({ kind: 'oidc-discovery'; connectionId: string } & TenantEnvelope)
  /** Look a domain's TXT record up. */
  | ({ kind: 'domain-verification'; domainId: string } & TenantEnvelope);

/** A DNS TXT lookup: the records, each as its strings (`dns.promises.resolveTxt`). */
export interface TxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

/** The resolver the domain checks use: the system's, or a test's. */
export const SSO_TXT_RESOLVER = Symbol('SSO_TXT_RESOLVER');
