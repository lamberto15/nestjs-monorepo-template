import { z } from 'zod';
import { defineSettings, setting } from '../settings/setting.types.js';

const limit = z.number().int().min(0).nullable();

/**
 * The deployment's default tenant limits (docs/tenancy.md, "Quotas"): null
 * is unlimited, which every one is until an operator sets a number
 * (`PUT /v1/settings/quotas.maxMembers/platform { value: 50 }`). No scope:
 * a tenant's administrators can't change them (the operators' per tenant
 * limits, `PUT /v1/tenants/{id}/quotas`, win over these).
 */
export const QUOTA_MAX_MEMBERS = setting({
  key: 'quotas.maxMembers',
  label: 'Default limit of members per tenant',
  schema: limit,
  default: null as number | null,
  scopes: [],
  public: false,
});
export const QUOTA_MAX_API_CLIENTS = setting({
  key: 'quotas.maxApiClients',
  label: 'Default limit of API clients per tenant',
  schema: limit,
  default: null as number | null,
  scopes: [],
  public: false,
});
export const QUOTA_MAX_STORAGE_BYTES = setting({
  key: 'quotas.maxStorageBytes',
  label: 'Default limit of stored bytes per tenant',
  description: 'Attachments and issued documents.',
  schema: limit,
  default: null as number | null,
  scopes: [],
  public: false,
});
export const QUOTA_MAX_RECORDS = setting({
  key: 'quotas.maxRecords',
  label: 'Default limit of records per feature and tenant',
  description: 'Each feature counts apart (notes, invoices…).',
  schema: limit,
  default: null as number | null,
  scopes: [],
  public: false,
});

export const QUOTA_SETTINGS = defineSettings([
  QUOTA_MAX_MEMBERS,
  QUOTA_MAX_API_CLIENTS,
  QUOTA_MAX_STORAGE_BYTES,
  QUOTA_MAX_RECORDS,
]);
