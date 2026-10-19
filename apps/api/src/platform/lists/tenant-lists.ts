import { Injectable } from '@nestjs/common';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessPolicy } from '../../iam/access/policies.js';
import { TENANT_LIST } from '../../iam/access/tenants.lists.js';
import { actsAsOperator } from '../../iam/auth/operator-only.js';
import { ListsRegistry } from './lists.registry.js';

/**
 * The operators' tenants list (GET /v1/tenants), described as the records'
 * are (GET /v1/lists/Tenant), to whoever may call that route: a principal
 * acting in the operator tenant (`@OperatorOnly()`) with
 * `Access.manageTenants`; anyone else gets a 403 there too. Registered
 * here because IAM can't import the platform (core ← iam ← platform). Not
 * a record: no capabilities, no custom fields, no recycle bin.
 */
@Injectable()
export class TenantListSource {
  constructor(registry: ListsRegistry, policy: AccessPolicy, tenancy: Tenancy) {
    registry.register({
      subject: 'Tenant',
      list: TENANT_LIST,
      capabilities: [],
      readable: async (principal) =>
        (await actsAsOperator(tenancy, principal)) &&
        (await policy.manageTenants(principal)),
    });
  }
}
