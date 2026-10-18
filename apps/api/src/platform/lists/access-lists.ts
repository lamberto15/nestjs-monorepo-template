import { Injectable } from '@nestjs/common';
import { AUDIT_LIST, USER_LIST } from '../../iam/access/access.lists.js';
import { AccessPolicy } from '../../iam/access/policies.js';
import { ListsRegistry } from './lists.registry.js';

/**
 * The access API's paged lists, described as the records' are
 * (GET /v1/lists/User, GET /v1/lists/Audit): `GET /v1/access/users`'s and
 * `GET /v1/access/audit`'s filters, sorts and fields, from the declaration
 * each route validates with, to whoever may call that route
 * (`AccessPolicy.open`, `AccessPolicy.readAudit`). Registered here because IAM can't import
 * the platform (core ← iam ← platform). Not a record: no capabilities, no
 * custom fields, no recycle bin. Roles and teams have no such list: their
 * routes answer every item at once, with no filter, sort or page to
 * describe.
 */
@Injectable()
export class AccessListSources {
  constructor(registry: ListsRegistry, policy: AccessPolicy) {
    registry.register({
      subject: 'User',
      list: USER_LIST,
      capabilities: [],
      readable: (principal) => policy.open(principal),
    });
    registry.register({
      subject: 'Audit',
      list: AUDIT_LIST,
      capabilities: [],
      readable: (principal) => policy.readAudit(principal),
    });
  }
}
