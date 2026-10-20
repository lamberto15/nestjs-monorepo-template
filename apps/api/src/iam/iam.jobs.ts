import { defineSystemJob } from './access/permissions.js';

/**
 * IAM's work without a user, as the system principal (docs/permissions.md,
 * "The system principal"), listed in ACCESS_PERMISSIONS. `permissions: []`:
 * the job checks none (it writes its own tables), so a service it calls
 * that does check refuses it; a permission nothing checks would only
 * advertise a grant in the catalog.
 */

/** AccessSeeder: the roles and the first administrator, on a deployment's first start. */
export const SEED_JOB = defineSystemJob({
  key: 'seed',
  label: 'First-boot seed',
  description:
    'Creates the built-in and declared roles and the first administrator on the first start.',
  permissions: [],
});

/** AuditRetentionJob: entries older than AUDIT_RETENTION_DAYS. */
export const AUDIT_RETENTION_JOB = defineSystemJob({
  key: 'audit-retention',
  label: 'Audit retention',
  description:
    'Deletes audit entries older than AUDIT_RETENTION_DAYS, every night.',
  permissions: [],
});

/** SoftDeletePurgeJob: the recycle bins' records past their retention. */
export const SOFT_DELETE_PURGE_JOB = defineSystemJob({
  key: 'soft-delete-purge',
  label: 'Recycle bin purge',
  description:
    'Deletes for good the records deleted longer ago than their retention, every night.',
  permissions: [],
});

/** SignUpTenantSweepJob: the tenants of sign-ups that never proved their address. */
export const SIGN_UP_TENANT_SWEEP_JOB = defineSystemJob({
  key: 'sign-up-tenant-sweep',
  label: 'Unverified sign-ups’ tenants',
  description:
    'Deletes the tenants self sign-ups made (TENANT_SIGN_UP) whose accounts never proved their address, every night.',
  permissions: [],
});

/** TenantDeletionJob: the tenants whose deletion grace period passed. */
export const TENANT_DELETION_JOB = defineSystemJob({
  key: 'tenant-deletion',
  label: 'Tenant deletion',
  description:
    'Erases the tenants whose deletion grace period passed (their rows, files, queued jobs and workflows), every night.',
  permissions: [],
});

/** SsoProcessor: SSO connections' discovery documents and domains' DNS records (iam/sso). */
export const SSO_JOB = defineSystemJob({
  key: 'sso',
  label: 'Single sign-on',
  description:
    "Fetches SSO connections' OpenID Connect discovery documents and checks the DNS records of the domains tenants verify.",
  permissions: [],
});

export const IAM_SYSTEM_JOBS = [
  SEED_JOB,
  AUDIT_RETENTION_JOB,
  SOFT_DELETE_PURGE_JOB,
  SIGN_UP_TENANT_SWEEP_JOB,
  TENANT_DELETION_JOB,
  SSO_JOB,
];
